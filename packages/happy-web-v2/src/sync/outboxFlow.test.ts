/**
 * B-814 (spec B-807 §5.5): the persistent outbox inside the real Sync send
 * path, against a fake server that dedupes by localId (as
 * sessionMessageStore does) and fake-indexeddb.
 *
 * The property every case pins: an input the user sent is on the server
 * exactly once — whatever happened to the page in between — or, past the
 * 10-minute window, waits visibly for the user to resend or discard it.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import type { OutboxRow } from './cache/outboxStore';

const tabs = vi.hoisted(() => ({ alive: new Set<string>(['tab-me']) }));
vi.mock('./tabLiveness', () => ({
    thisTabId: () => 'tab-me',
    holdTabLiveness: () => {},
    isTabAlive: async (tab: string) => tabs.alive.has(tab),
    withTabLock: async (_name: string, fn: () => Promise<void>) => fn(),
}));

let sync: typeof import('./sync').sync;
let storage: typeof import('./storage').storage;
let apiSocket: typeof import('./apiSocket').apiSocket;
let syncCache: typeof import('./cache/syncCache').syncCache;
let outboxStore: typeof import('./cache/syncCache').outboxStore;

type ServerMessage = { id: string; seq: number; localId: string | null; content: { t: 'encrypted'; c: string }; createdAt: number; updatedAt: number };

let server: Map<string, ServerMessage[]>;
/** Every POST as it arrived, with what IndexedDB held for its localIds at that moment. */
let posts: Array<{ sid: string; localIds: string[]; durable: string[] }>;
let postStatus: number;
let relayed: number;
let encrypts: number;
let counter = 0;

beforeAll(async () => {
    installBrowserTestGlobals();
    ({ sync } = await import('./sync'));
    ({ storage } = await import('./storage'));
    ({ apiSocket } = await import('./apiSocket'));
    ({ syncCache, outboxStore } = await import('./cache/syncCache'));
});

const cipher = (record: unknown) => `enc:${JSON.stringify(record)}`;
const plain = (body: string) => (body.startsWith('enc:') ? JSON.parse(body.slice(4)) : null);

beforeEach(async () => {
    server = new Map();
    posts = [];
    postStatus = 200;
    relayed = 0;
    encrypts = 0;
    tabs.alive = new Set(['tab-me']);
    const encryption = {
        encryptRawRecord: async (record: unknown) => { encrypts += 1; return cipher(record); },
        decryptRaw: async (body: string) => plain(body),
        decryptMessage: async (m: ServerMessage) => decrypt(m),
        decryptMessages: async (ms: ServerMessage[]) => ms.map(decrypt),
        forgetMessages: () => {},
    };
    (sync as unknown as { encryption: unknown }).encryption = { getSessionEncryption: (id: string) => (server.has(id) ? encryption : null), removeSessionEncryption: () => {} };
    vi.spyOn(apiSocket, 'deliverSessionMessages').mockImplementation(async () => { relayed += 1; return null as never; });
    vi.spyOn(apiSocket, 'request').mockImplementation(async (path, init) => {
        const url = new URL(String(path), 'http://x');
        const sid = url.pathname.split('/')[3];
        const all = server.get(sid) ?? [];
        if (init?.method === 'POST') {
            const body = JSON.parse(String(init.body)) as { messages: Array<{ localId: string; content: string }> };
            const durable = (await outboxStore.all()).map((row) => row.localId);
            posts.push({ sid, localIds: body.messages.map((m) => m.localId), durable });
            if (postStatus !== 200) return new Response('{}', { status: postStatus });
            const acks = body.messages.map((m) => {
                // sessionMessageStore: an existing localId returns its original seq and is not stored again.
                const existing = all.find((s) => s.localId === m.localId);
                return existing ?? storeRaw(sid, m.content, m.localId);
            });
            return json({ messages: acks.map(({ id, seq, localId, createdAt, updatedAt }) => ({ id, seq, localId, createdAt, updatedAt })) });
        }
        const after = url.searchParams.get('after_seq');
        const messages = after !== null ? all.filter((m) => m.seq > Number(after)) : [...all].reverse();
        return json({ messages, hasMore: false });
    });
    await syncCache.open(`outbox-account-${++counter}`);
});

afterEach(async () => {
    await settle();
    vi.restoreAllMocks();
});

function json(body: unknown) {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function decrypt(message: ServerMessage) {
    return { id: message.id, seq: message.seq, localId: message.localId, createdAt: message.createdAt, content: plain(message.content.c) };
}

function storeRaw(sid: string, body: string, localId: string | null): ServerMessage {
    const list = server.get(sid)!;
    const seq = (list.at(-1)?.seq ?? 0) + 1;
    const message: ServerMessage = { id: `${sid}-m${seq}`, seq, localId, content: { t: 'encrypted', c: body }, createdAt: seq, updatedAt: seq };
    list.push(message);
    return message;
}

const userRecord = (text: string) => ({ role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'web' } });

function newSession(): string {
    const sid = `b814-${++counter}`;
    server.set(sid, []);
    storeRaw(sid, cipher({ role: 'user', content: { type: 'text', text: 'history' } }), null);
    storage.setState((state) => ({
        sessions: {
            ...state.sessions,
            [sid]: { id: sid, presence: 'online', thinking: false, active: true, metadata: { flavor: 'claude', path: '/tmp/x', host: 'h', machineId: 'm1' }, agentState: null } as never,
        },
    }));
    return sid;
}

async function settle() {
    for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

const bubbles = (sid: string) => (storage.getState().sessionMessages[sid]?.messages ?? [])
    .filter((m) => m.kind === 'user-text')
    .map((m) => m as { text: string; localId: string | null; sendState?: string; sendStale?: true })
    .reverse();
const serverTexts = (sid: string) => server.get(sid)!.map((m) => plain(m.content.c).content.text as string);

/** A reload as far as this session goes: memory forgets it, IndexedDB keeps it. */
function reload(sid: string) {
    const s = sync as unknown as Record<string, Map<string, unknown>>;
    for (const key of ['sessionLastSeq', 'sessionOldestSeq', 'messagesSync', 'sendSync', 'pendingOutbox', 'unverifiedCacheHits']) s[key].delete(sid);
    for (const [localId, record] of [...s.outboxRecords]) if ((record as { sessionId: string }).sessionId === sid) s.outboxRecords.delete(localId);
    storage.getState().resetSessionMessages(sid);
}

const reclaim = () => (sync as unknown as { reclaimOutbox: () => Promise<void> }).reclaimOutbox();

function orphan(sid: string, localId: string, text: string, patch: Partial<OutboxRow> = {}): OutboxRow {
    return {
        localId, sid, body: cipher(userRecord(text)), createdAt: Date.now() - 60_000, state: 'queued',
        attempts: 0, ownerTabId: 'tab-gone', group: `g-${localId}`, order: 0, ...patch,
    };
}

describe('B-814 write-through', () => {
    it('the row is durable before the POST leaves; the ack deletes it', async () => {
        const sid = newSession();
        const localId = (await sync.sendMessage(sid, 'hello')) as string;
        await settle();
        expect(posts).toHaveLength(1);
        expect(posts[0].localIds).toEqual([localId]);
        expect(posts[0].durable).toContain(localId);
        expect(await outboxStore.all()).toEqual([]);
        expect(serverTexts(sid)).toEqual(['history', 'hello']);
    });

    it('a final rejection leaves the row failed (not re-sent on its own after a reload)', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const sid = newSession();
        postStatus = 400;
        const localId = (await sync.sendMessage(sid, 'rejected')) as string;
        await settle();
        const [row] = await outboxStore.all();
        expect(row).toMatchObject({ localId, sid, state: 'failed', ownerTabId: 'tab-me' });
        expect(plain(row.body).content.text).toBe('rejected');
    });

    it('stores only ciphertext — no plaintext field on the row', async () => {
        const sid = newSession();
        postStatus = 400;
        vi.spyOn(console, 'log').mockImplementation(() => {});
        await sync.sendMessage(sid, 'secret words');
        await settle();
        const [row] = await outboxStore.all();
        expect(Object.keys(row).sort()).toEqual(['attempts', 'body', 'createdAt', 'group', 'localId', 'order', 'ownerTabId', 'sid', 'state']);
    });
});

describe('B-814 takeover after a reload (§5.5.3)', () => {
    it('≤10 min: re-sent once with the same localId over HTTP only; shown, then confirmed; the row is gone', async () => {
        const sid = newSession();
        await outboxStore.put([orphan(sid, 'lost-1', 'typed before the reload')]);
        await reclaim();
        await settle();
        expect(posts.map((p) => p.localIds)).toEqual([['lost-1']]);
        expect(relayed).toBe(0);
        expect(bubbles(sid).map((b) => [b.text, b.sendState])).toEqual([['history', undefined], ['typed before the reload', undefined]]);
        expect(serverTexts(sid)).toEqual(['history', 'typed before the reload']);
        expect(await outboxStore.all()).toEqual([]);
    });

    it('the POST had landed before the page died: the latest page shows it, nothing is re-sent, the row is dropped', async () => {
        const sid = newSession();
        const row = orphan(sid, 'landed-1', 'already there');
        storeRaw(sid, row.body, 'landed-1');
        await outboxStore.put([row]);
        await reclaim();
        await settle();
        expect(posts).toEqual([]);
        expect(bubbles(sid).map((b) => b.text)).toEqual(['history', 'already there']);
        expect(await outboxStore.all()).toEqual([]);
    });

    it('a re-send of an input the server already has (ack lost) is deduped by localId — one copy', async () => {
        const sid = newSession();
        const row = orphan(sid, 'dup-1', 'sent twice?');
        await outboxStore.put([row]);
        // Stored after the latest page was read: the takeover cannot see it, only the server's dedupe can.
        const realGet = (apiSocket.request as unknown as { getMockImplementation: () => (p: unknown, i?: RequestInit) => Promise<Response> }).getMockImplementation();
        let first = true;
        vi.mocked(apiSocket.request).mockImplementation(async (path, init) => {
            const response = await realGet(path, init);
            if (first && init?.method !== 'POST') { first = false; storeRaw(sid, row.body, 'dup-1'); }
            return response;
        });
        await reclaim();
        await settle();
        expect(posts.map((p) => p.localIds)).toEqual([['dup-1']]);
        expect(serverTexts(sid)).toEqual(['history', 'sent twice?']);
        expect(bubbles(sid).filter((b) => b.text === 'sent twice?')).toHaveLength(1);
    });

    it('>10 min: not sent; 「未发送」 (stale) until the user resends — then sent once, row gone', async () => {
        const sid = newSession();
        await outboxStore.put([orphan(sid, 'old-1', 'an hour ago', { createdAt: Date.now() - 11 * 60_000 })]);
        await reclaim();
        await settle();
        expect(posts).toEqual([]);
        expect(bubbles(sid).at(-1)).toMatchObject({ text: 'an hour ago', sendState: 'failed', sendStale: true });
        expect((await outboxStore.all())[0]).toMatchObject({ localId: 'old-1', state: 'failed', ownerTabId: 'tab-me' });

        expect(sync.retrySend(sid, 'old-1')).toBe(true);
        await settle();
        expect(posts.map((p) => p.localIds)).toEqual([['old-1']]);
        expect(bubbles(sid).at(-1)?.text).toBe('an hour ago');
        expect(bubbles(sid).at(-1)?.sendState).toBeUndefined();
        expect(await outboxStore.all()).toEqual([]);
    });

    it('the user\'s Resend restarts the 10-minute clock: still unsent at the next reload → re-sent on its own', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const sid = newSession();
        await outboxStore.put([orphan(sid, 'old-3', 'try again', { createdAt: Date.now() - 30 * 60_000 })]);
        await reclaim();
        await settle();
        postStatus = 503; // the retry does not get through before the page goes away
        const before = Date.now();
        expect(sync.retrySend(sid, 'old-3')).toBe(true);
        await settle();
        expect((await outboxStore.all())[0]).toMatchObject({ localId: 'old-3', state: 'queued', attempts: 1 });
        expect((await outboxStore.all())[0].createdAt).toBeGreaterThanOrEqual(before);
        // Reload: the next load takes it over and sends it without asking.
        reload(sid);
        const [row] = await outboxStore.all();
        await outboxStore.put([{ ...row, ownerTabId: 'tab-previous-load' }]);
        postStatus = 200;
        posts = [];
        await reclaim();
        await settle();
        expect(posts.map((p) => p.localIds)).toEqual([['old-3']]);
        expect(serverTexts(sid).filter((t) => t === 'try again')).toHaveLength(1);
    });

    it('>10 min: discard drops the bubble and the row; nothing is sent', async () => {
        const sid = newSession();
        await outboxStore.put([orphan(sid, 'old-2', 'never mind', { createdAt: Date.now() - 11 * 60_000 })]);
        await reclaim();
        await settle();
        expect(sync.discardStaleMessage(sid, 'old-2')).toBe(true);
        await settle();
        expect(bubbles(sid).map((b) => b.text)).toEqual(['history']);
        expect(await outboxStore.all()).toEqual([]);
        expect(posts).toEqual([]);
    });

    it('a row that already failed before the reload stays failed, however recent', async () => {
        const sid = newSession();
        await outboxStore.put([orphan(sid, 'f-1', 'failed earlier', { state: 'failed', createdAt: Date.now() - 1_000 })]);
        await reclaim();
        await settle();
        expect(posts).toEqual([]);
        expect(bubbles(sid).at(-1)).toMatchObject({ sendState: 'failed', sendStale: true });
    });

    it('rows of a tab that is still open are left to it (two tabs never both send)', async () => {
        const sid = newSession();
        tabs.alive.add('tab-other');
        await outboxStore.put([orphan(sid, 'theirs', 'other tab', { ownerTabId: 'tab-other' })]);
        await reclaim();
        await settle();
        expect(posts).toEqual([]);
        expect(bubbles(sid).map((b) => b.text)).toEqual([]);
        // The other tab closes: the next pass takes it over and sends it once.
        tabs.alive.delete('tab-other');
        await reclaim();
        await reclaim();
        await settle();
        expect(posts.map((p) => p.localIds)).toEqual([['theirs']]);
    });

    it('a turn (attachment + text) is re-sent together, in its order', async () => {
        const sid = newSession();
        const file = { role: 'session', content: { type: 'session', data: { id: 'e1', time: 1, role: 'user', ev: { t: 'file', ref: 'r', name: 'a.png', size: 1, mimeType: 'image/png' } } } };
        await outboxStore.put([
            { ...orphan(sid, 'turn-text', 'with a picture'), group: 'turn', order: 1 },
            { ...orphan(sid, 'turn-file', ''), body: cipher(file), group: 'turn', order: 0 },
        ]);
        await reclaim();
        await settle();
        expect(posts.flatMap((p) => p.localIds)).toEqual(['turn-file', 'turn-text']);
    });

    it('a deleted session takes its rows with it', async () => {
        const sid = newSession();
        await outboxStore.put([orphan('gone-session', 'g-1', 'nowhere to go')]);
        await reclaim();
        await settle();
        expect(await outboxStore.all()).toEqual([]);
        expect(posts).toEqual([]);
        void sid;
    });

    it('a real reload in the middle of a send: the input reaches the server exactly once', async () => {
        const sid = newSession();
        // The POST hangs (the page dies with it on the wire).
        let release!: () => void;
        const hung = new Promise<void>((resolve) => { release = resolve; });
        const realImpl = vi.mocked(apiSocket.request).getMockImplementation()!;
        vi.mocked(apiSocket.request).mockImplementation(async (path, init) => {
            if (init?.method === 'POST' && posts.length === 0) {
                const response = await realImpl(path, init); // the server stores it…
                await hung; // …but the ack never reaches the page
                return response;
            }
            return realImpl(path, init);
        });
        const localId = (await sync.sendMessage(sid, 'mid-flight')) as string;
        await settle();
        expect(posts).toHaveLength(1);
        reload(sid);
        // Previous load's tab id is gone; the row is an orphan now.
        const [row] = await outboxStore.all();
        await outboxStore.put([{ ...row, ownerTabId: 'tab-previous-load' }]);
        await reclaim();
        await settle();
        release();
        await settle();
        expect(serverTexts(sid).filter((t) => t === 'mid-flight')).toHaveLength(1);
        expect(bubbles(sid).filter((b) => b.text === 'mid-flight')).toHaveLength(1);
        expect(bubbles(sid).find((b) => b.text === 'mid-flight')?.localId).toBe(localId);
    });
});

describe('B-814 × B-801 (§5.5.4)', () => {
    it('a pending session\'s first message sent again with the same localId is not a second bubble or POST', async () => {
        const sid = newSession();
        postStatus = 503; // keeps it in the outbox (retryable)
        vi.spyOn(console, 'log').mockImplementation(() => {});
        await sync.sendMessage(sid, 'first message', { localId: 'pending-item-1' });
        await sync.whenOutboxPersisted(sid);
        expect((await outboxStore.all()).map((r) => r.localId)).toEqual(['pending-item-1']);
        await sync.sendMessage(sid, 'first message', { localId: 'pending-item-1' });
        expect(bubbles(sid).filter((b) => b.text === 'first message')).toHaveLength(1);
        postStatus = 200;
        (sync as unknown as { getSendSync: (id: string) => { invalidateNow: () => void } }).getSendSync(sid).invalidateNow();
        await settle();
        expect(serverTexts(sid).filter((t) => t === 'first message')).toHaveLength(1);
        // Not queued a second time either: every attempt carried it once, encrypted once.
        expect(posts.every((p) => p.localIds.length === 1 && p.localIds[0] === 'pending-item-1')).toBe(true);
        expect(encrypts).toBe(1);
    });

    it('whenOutboxPersisted resolves only after the row is on disk', async () => {
        const sid = newSession();
        postStatus = 503;
        vi.spyOn(console, 'log').mockImplementation(() => {});
        await sync.sendMessage(sid, 'draft first', { localId: 'pending-item-2' });
        await sync.whenOutboxPersisted(sid);
        expect((await outboxStore.all()).some((r) => r.localId === 'pending-item-2')).toBe(true);
    });
});
