/**
 * B-722: a text-only send is on screen before its encryption finishes, keeps
 * its place when the server confirms it (no duplicate, no jump), fails
 * visibly — and restorably — when it cannot be encrypted, and leaves the
 * outbox in the order it was shown. Drives the real Sync + storage.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import type { RawRecord } from './typesRaw';

let sync: typeof import('./sync').sync;
let storage: typeof import('./storage').storage;
let apiSocket: typeof import('./apiSocket').apiSocket;
let confirmations: typeof import('./sendConfirmations');

const SID = 'b722-session';

type Deferred = { promise: Promise<string>; resolve: (value: string) => void; reject: (error: Error) => void };
function deferred(): Deferred {
    let resolve!: (value: string) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

let encryptions: Deferred[];
let posted: Array<Array<{ localId: string; content: string }>>;
let seq: number;

beforeAll(async () => {
    installBrowserTestGlobals();
    ({ sync } = await import('./sync'));
    ({ storage } = await import('./storage'));
    ({ apiSocket } = await import('./apiSocket'));
    confirmations = await import('./sendConfirmations');
});

beforeEach(() => {
    encryptions = [];
    posted = [];
    seq = 100;
    const encryption = {
        encryptRawRecord: (_record: RawRecord) => {
            const next = deferred();
            encryptions.push(next);
            return next.promise;
        },
    };
    (sync as unknown as { encryption: unknown }).encryption = { getSessionEncryption: (id: string) => (id === SID ? encryption : null) };
    vi.spyOn(apiSocket, 'request').mockImplementation(async (_path, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ localId: string; content: string }> };
        posted.push(body.messages);
        return new Response(JSON.stringify({
            messages: body.messages.map((message) => ({ id: `srv-${message.localId}`, seq: ++seq, localId: message.localId, createdAt: 1, updatedAt: 1 })),
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    storage.setState((state) => ({
        sessions: {
            ...state.sessions,
            [SID]: { id: SID, presence: 'online', thinking: false, active: true, metadata: { flavor: 'claude', path: '/tmp/x', host: 'h' }, agentState: null } as never,
        },
    }));
    storage.getState().applyMessages(SID, [{ id: 'h1', localId: null, createdAt: 1, role: 'agent', isSidechain: false, content: [{ type: 'text', text: 'earlier', uuid: 'u1', parentUUID: null }] as never, seq: 1 } as never]);
});

afterEach(async () => {
    // Never leave this session's outbox chain waiting on an unresolved encryption.
    for (const pending of encryptions) pending.resolve('cipher-cleanup');
    await settle();
    vi.restoreAllMocks();
    confirmations.__resetSendConfirmationsForTests();
    storage.getState().deleteSession?.(SID);
});

const userTexts = () => (storage.getState().sessionMessages[SID]?.messages ?? [])
    .filter((message) => message.kind === 'user-text')
    .map((message) => ({ text: (message as { text: string }).text, sendState: (message as { sendState?: string }).sendState }));

async function settle() {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('B-722 optimistic send', () => {
    it('shows the bubble as sending in the same task, before encryption resolves; the ack confirms it in place', async () => {
        const receipt = sync.sendMessage(SID, 'hello there');
        // Synchronously after the call — no await yet.
        expect(userTexts()).toEqual([{ text: 'hello there', sendState: 'sending' }]);
        expect(typeof await receipt).toBe('string');
        await settle();
        expect(encryptions).toHaveLength(1);
        expect(posted).toHaveLength(0); // nothing leaves before it is encrypted

        encryptions[0].resolve('cipher-1');
        await settle();
        expect(posted).toEqual([[{ localId: await receipt, content: 'cipher-1' }]]);
        // Confirmed in place: one row, no send state, briefly flagged as just sent.
        expect(userTexts()).toEqual([{ text: 'hello there', sendState: undefined }]);
        expect(confirmations.useSendConfirmations.getState().confirmedAt[(await receipt) as string]).toBeTypeOf('number');
    });

    it('keeps send order: a later send is encrypted only after the earlier one entered the outbox', async () => {
        const first = await sync.sendMessage(SID, 'first');
        const second = await sync.sendMessage(SID, 'second');
        await settle();
        // Both are on screen at once, in send order (newest first in the store).
        expect(userTexts().map((m) => m.text)).toEqual(['second', 'first']);
        expect(encryptions).toHaveLength(1);
        encryptions[0].resolve('cipher-1');
        await settle();
        expect(encryptions).toHaveLength(2);
        encryptions[1].resolve('cipher-2');
        await settle();
        expect(posted.flat().map((m) => m.localId)).toEqual([first, second]);
        expect(userTexts()).toEqual([{ text: 'second', sendState: undefined }, { text: 'first', sendState: undefined }]);
    });

    it('a failed encryption fails the bubble visibly and restorably; Retry encrypts again and sends it', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const localId = (await sync.sendMessage(SID, 'oops')) as string;
        await settle();
        encryptions[0].reject(new Error('subtle crypto unavailable'));
        await settle();
        const failed = storage.getState().sessionMessages[SID].messages.find((m) => m.kind === 'user-text') as { sendState?: string; sendRestorable?: boolean };
        expect(failed.sendState).toBe('failed');
        expect(failed.sendRestorable).toBe(true);
        expect(posted).toEqual([]);

        expect(sync.retrySend(SID, localId)).toBe(true);
        expect(userTexts()).toEqual([{ text: 'oops', sendState: 'sending' }]);
        await settle();
        encryptions[1].resolve('cipher-retry');
        await settle();
        expect(posted).toEqual([[{ localId, content: 'cipher-retry' }]]);
        expect(userTexts()).toEqual([{ text: 'oops', sendState: undefined }]);
    });
});
