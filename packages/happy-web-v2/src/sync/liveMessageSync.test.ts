/**
 * B-805: a live `new-message` update costs no history GET unless the seq run
 * has a hole. Before, every update of ANY session invalidated the messages
 * sync (the "Ping session" called onSessionVisible), so production paid one
 * `after_seq` GET per realtime message per tab (B-802 DESIGN-REVIEW §2.3-1).
 * Drives the real Sync.handleUpdate + storage against a fake server.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import { ANCHOR_BUFFER_LIMIT, AnchorBuffer, planLiveMessage } from './liveMessagePlan';

let sync: typeof import('./sync').sync;
let storage: typeof import('./storage').storage;
let apiSocket: typeof import('./apiSocket').apiSocket;

type ServerMessage = { id: string; seq: number; localId: null; content: { t: 'encrypted'; c: string }; createdAt: number; updatedAt: number };

/** Per-session server history; the fake API pages it like /v3/sessions/:id/messages. */
let server: Map<string, ServerMessage[]>;
let gets: string[];
let counter = 0;
/** While set, a latest-page (before_seq) request answers with the server state AT REQUEST TIME only once released. */
let pageGate: Promise<void> | null;

beforeAll(async () => {
    installBrowserTestGlobals();
    ({ sync } = await import('./sync'));
    ({ storage } = await import('./storage'));
    ({ apiSocket } = await import('./apiSocket'));
});

function decrypt(message: ServerMessage) {
    return { id: message.id, seq: message.seq, localId: null, createdAt: message.createdAt, content: JSON.parse(message.content.c) };
}

beforeEach(() => {
    server = new Map();
    gets = [];
    pageGate = null;
    const encryption = {
        decryptMessage: async (message: ServerMessage) => decrypt(message),
        decryptMessages: async (messages: ServerMessage[]) => messages.map(decrypt),
    };
    (sync as unknown as { encryption: unknown }).encryption = { getSessionEncryption: (id: string) => (server.has(id) ? encryption : null) };
    vi.spyOn(apiSocket, 'request').mockImplementation(async (path) => {
        const url = new URL(String(path), 'http://x');
        const sid = url.pathname.split('/')[3];
        const all = server.get(sid) ?? [];
        gets.push(`${sid}?${url.searchParams.has('after_seq') ? 'after' : 'before'}`);
        const after = url.searchParams.get('after_seq');
        const messages = after !== null
            ? all.filter((m) => m.seq > Number(after))
            : [...all].reverse();
        if (after === null && pageGate) await pageGate;
        return new Response(JSON.stringify({ messages, hasMore: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
});

afterEach(() => {
    vi.restoreAllMocks();
});

function newSession(): string {
    const sid = `b805-${++counter}`;
    server.set(sid, []);
    storage.setState((state) => ({
        sessions: {
            ...state.sessions,
            [sid]: { id: sid, presence: 'online', thinking: false, active: true, metadata: { flavor: 'claude', path: '/tmp/x', host: 'h' }, agentState: null } as never,
        },
    }));
    return sid;
}

/** Store a message on the fake server (the CLI posted it). */
function store(sid: string, text: string): ServerMessage {
    const list = server.get(sid)!;
    const seq = list.length + 1;
    const message: ServerMessage = {
        id: `${sid}-m${seq}`, seq, localId: null, createdAt: seq, updatedAt: seq,
        content: { t: 'encrypted', c: JSON.stringify({ role: 'user', content: { type: 'text', text } }) },
    };
    list.push(message);
    return message;
}

async function deliver(sid: string, message: ServerMessage) {
    await (sync as unknown as { handleUpdate: (u: unknown) => Promise<void> }).handleUpdate({
        id: `u-${message.id}`, seq: message.seq, createdAt: message.createdAt,
        body: { t: 'new-message', sid, message },
    });
}

function hold() {
    let release!: () => void;
    pageGate = new Promise<void>((resolve) => { release = resolve; });
    return () => { pageGate = null; release(); };
}

async function settle() {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Transcript texts oldest-first. */
const texts = (sid: string) => (storage.getState().sessionMessages[sid]?.messages ?? [])
    .filter((m) => m.kind === 'user-text')
    .map((m) => (m as { text: string }).text)
    .reverse();

describe('B-805 live new-message: no GET per message', () => {
    it('50 consecutive live messages in an open session issue 0 history GETs and all land in order', async () => {
        const sid = newSession();
        store(sid, 'm1');
        sync.onSessionEnter(sid);
        await settle();
        expect(gets).toEqual([`${sid}?before`]);
        gets = [];

        for (let i = 2; i <= 51; i += 1) await deliver(sid, store(sid, `m${i}`));
        await settle();

        expect(gets).toEqual([]);
        expect(texts(sid)).toEqual(Array.from({ length: 51 }, (_, i) => `m${i + 1}`));
    });

    it('a seq gap issues exactly 1 forward GET and fills the hole', async () => {
        const sid = newSession();
        store(sid, 'm1');
        sync.onSessionEnter(sid);
        await settle();
        gets = [];

        store(sid, 'm2'); // its update is lost
        await deliver(sid, store(sid, 'm3'));
        await settle();

        expect(gets).toEqual([`${sid}?after`]);
        expect(texts(sid)).toEqual(['m1', 'm2', 'm3']);

        // Back on a contiguous run: no more GETs.
        gets = [];
        await deliver(sid, store(sid, 'm4'));
        await settle();
        expect(gets).toEqual([]);
        expect(texts(sid)).toEqual(['m1', 'm2', 'm3', 'm4']);
    });

    it('an echo (seq already reduced, e.g. relay delivered it first) issues no GET', async () => {
        const sid = newSession();
        const first = store(sid, 'm1');
        sync.onSessionEnter(sid);
        await settle();
        gets = [];

        await deliver(sid, first);
        await settle();
        expect(gets).toEqual([]);
        expect(texts(sid)).toEqual(['m1']);
    });

    it('a never-opened session: N live messages → its latest page fetched ONCE, 0 after_seq, nothing lost', async () => {
        const sid = newSession();
        store(sid, 'm1');
        store(sid, 'm2');
        const release = hold();
        await deliver(sid, store(sid, 'm3')); // first update → the one page request
        for (let i = 4; i <= 10; i += 1) await deliver(sid, store(sid, `m${i}`)); // while it is in flight
        await settle();
        expect(gets).toEqual([`${sid}?before`]);
        release();
        await settle();

        expect(gets).toEqual([`${sid}?before`]);
        expect(texts(sid)).toEqual(Array.from({ length: 10 }, (_, i) => `m${i + 1}`));
        expect(storage.getState().sessionMessages[sid]?.isLoaded).toBe(true);

        // Anchored past the buffered run: the next update is the fast path.
        await deliver(sid, store(sid, 'm11'));
        await settle();
        expect(gets).toEqual([`${sid}?before`]);
        expect(texts(sid)).toHaveLength(11);
    });

    it('updates arriving while the viewed session\'s first page loads cost no after_seq', async () => {
        const sid = newSession();
        store(sid, 'm1');
        const release = hold();
        sync.onSessionEnter(sid);
        await settle();
        for (let i = 2; i <= 6; i += 1) await deliver(sid, store(sid, `m${i}`));
        release();
        await settle();

        expect(gets).toEqual([`${sid}?before`]);
        expect(texts(sid)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    });

    it('a hole among the buffered updates is a real gap: exactly 1 forward GET fills it', async () => {
        const sid = newSession();
        const release = hold();
        await deliver(sid, store(sid, 'm1'));
        store(sid, 'm2'); // its update is lost
        await deliver(sid, store(sid, 'm3'));
        release();
        await settle();

        expect(gets).toEqual([`${sid}?before`, `${sid}?after`]);
        expect(texts(sid)).toEqual(['m1', 'm2', 'm3']);
    });

    it('entering a session again catches up forward (the resume / reconnect path)', async () => {
        const sid = newSession();
        store(sid, 'm1');
        sync.onSessionEnter(sid);
        await settle();
        gets = [];

        store(sid, 'm2'); // arrived while the link was down — no update
        sync.onSessionEnter(sid);
        await settle();
        expect(gets).toEqual([`${sid}?after`]);
        expect(texts(sid)).toEqual(['m1', 'm2']);
    });
});

describe('B-805 planLiveMessage', () => {
    it('applies the next seq, drops echoes, refetches gaps, defers without an anchor', () => {
        expect(planLiveMessage(10, 11)).toBe('apply');
        expect(planLiveMessage(10, 10)).toBe('echo');
        expect(planLiveMessage(10, 3)).toBe('echo');
        expect(planLiveMessage(10, 12)).toBe('refetch');
        expect(planLiveMessage(undefined, 5)).toBe('defer');
    });
});

describe('B-805 AnchorBuffer', () => {
    it('asks for the page on the first update only, also once the request is already open', () => {
        const buffer = new AnchorBuffer<string>();
        expect(buffer.add('s', 5, 'a')).toBe(true);
        expect(buffer.add('s', 6, 'b')).toBe(false);
        buffer.open('t');
        expect(buffer.add('t', 1, 'x')).toBe(false);
    });

    it('drains past the anchor in seq order; unrenderable updates count as seen, not applied', () => {
        const buffer = new AnchorBuffer<string>();
        buffer.add('s', 7, 'c');
        buffer.add('s', 5, 'a');
        buffer.add('s', 6, null);
        buffer.add('s', 4, 'old');
        expect(buffer.drain('s', 4)).toEqual({ messages: ['a', 'c'], seqs: [5, 6, 7] });
        // Drained: the next update asks again (a reload of the page would be a new session state).
        expect(buffer.add('s', 8, 'd')).toBe(true);
    });

    it('drops updates past the limit without recording them, so they surface as a gap', () => {
        const buffer = new AnchorBuffer<number>();
        for (let seq = 1; seq <= ANCHOR_BUFFER_LIMIT + 3; seq += 1) buffer.add('s', seq, seq);
        const { seqs } = buffer.drain('s', 0);
        expect(seqs).toHaveLength(ANCHOR_BUFFER_LIMIT);
        expect(seqs.at(-1)).toBe(ANCHOR_BUFFER_LIMIT);
    });
});
