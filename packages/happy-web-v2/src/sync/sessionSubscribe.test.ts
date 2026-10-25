/**
 * B-812 (B-807 spec §5.2–5.3, §9.2-4/5/9/10): the real Sync (merge entry +
 * scheduler + storage) against a fake server reached over a fake socket
 * (`sync-hello` / `session-subscribe` acks) and a fake REST API, with fake
 * timers for the 400ms reorder window, the 2s/5s ack deadlines, the 5 min
 * retention and the 120s reconcile.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import { SYNC_ACK_TIMEOUT_MS, SYNC_FIRST_HELLO_TIMEOUT_MS } from '@slopus/happy-wire';
import { REORDER_WINDOW_MS } from './sessionMerge';
import { HELLO_HEDGE_MS, MAX_SUBSCRIPTIONS, NEGOTIATION_REST_DELAY_MS, RECONCILE_INTERVAL_MS, SUBSCRIPTION_RETAIN_MS } from './sessionSyncScheduler';

let sync: typeof import('./sync').sync;
let storage: typeof import('./storage').storage;
let apiSocket: typeof import('./apiSocket').apiSocket;
let catchUpStore: typeof import('./catchUpStatus').catchUpStore;

type ServerMessage = { id: string; seq: number; localId: null; content: { t: 'encrypted'; c: string }; createdAt: number; updatedAt: number };
type ServerSession = { messages: ServerMessage[]; head: number };
type Emit = { event: string; payload: any };
type Answer = (value: unknown) => void;

let server: Map<string, ServerSession>;
let emits: Emit[];
let gets: string[];
/** 'ok' = new server; 'disabled' = SYNC_SUBSCRIBE_DISABLED / not on SYNC_SUBSCRIBE_ACCOUNTS; 'no-handler' = an old server. */
let serverMode: 'ok' | 'disabled' | 'no-handler';
/** When set, a session-subscribe ack is handed to the test instead of answered. */
let holdSubscribe: ((payload: any, answer: Answer) => void) | null;
let holdHello: ((payload: any, answer: Answer) => void) | null;
let connected: boolean;
/** While set, REST reads wait for it; their abort signals are kept in `restSignals`. */
let restGate: Promise<void> | null;
let restSignals: AbortSignal[];
let livenessChecks: number;
let counter = 0;

beforeAll(async () => {
    installBrowserTestGlobals();
    ({ sync } = await import('./sync'));
    ({ storage } = await import('./storage'));
    ({ apiSocket } = await import('./apiSocket'));
    ({ catchUpStore } = await import('./catchUpStatus'));
});

function decrypt(message: ServerMessage) {
    return { id: message.id, seq: message.seq, localId: null, createdAt: message.createdAt, content: JSON.parse(message.content.c) };
}

/** The B-811 server semantics (§3.3, §4.2–4.3): head and messages from one snapshot. */
function snapshot(sub: { sid: string; afterSeq: number | null; limit?: number }) {
    const session = server.get(sub.sid);
    if (!session) return { sid: sub.sid, ok: false, error: 'not_found' };
    const limit = sub.limit ?? 200;
    if (sub.afterSeq === null) {
        const page = session.messages.slice(-limit);
        return { sid: sub.sid, ok: true, headSeq: session.head, messages: page, hasMore: false, ...(page.length ? { oldestSeq: page[0].seq } : {}) };
    }
    if (session.head <= sub.afterSeq) return { sid: sub.sid, ok: true, headSeq: session.head, messages: [], hasMore: false };
    const rows = session.messages.filter((m) => m.seq > sub.afterSeq!);
    return { sid: sub.sid, ok: true, headSeq: session.head, messages: rows.slice(0, limit), hasMore: rows.length > limit };
}

beforeEach(() => {
    vi.useFakeTimers();
    server = new Map();
    emits = [];
    gets = [];
    serverMode = 'ok';
    holdSubscribe = null;
    holdHello = null;
    connected = true;
    livenessChecks = 0;
    restGate = null;
    restSignals = [];
    localStorage.removeItem('vh.sync.lastMode');
    const encryption = {
        decryptMessage: async (message: ServerMessage) => decrypt(message),
        decryptMessages: async (messages: ServerMessage[]) => messages.map(decrypt),
    };
    (sync as unknown as { encryption: unknown }).encryption = { getSessionEncryption: (id: string) => (server.has(id) ? encryption : null) };
    vi.spyOn(apiSocket, 'isControlConnected').mockImplementation(() => connected);
    vi.spyOn(apiSocket, 'checkLiveness').mockImplementation(async () => { livenessChecks += 1; return 'alive'; });
    vi.spyOn(apiSocket, 'emitWithTimeout').mockImplementation((event, payload, timeoutMs) => new Promise((resolve, reject) => {
        emits.push({ event, payload });
        const timer = setTimeout(() => reject(new Error('operation has timed out')), timeoutMs);
        const answer: Answer = (value) => { clearTimeout(timer); resolve(value as never); };
        if (serverMode === 'no-handler') return; // an old server: no handler, no ack, ever
        const p = payload as any;
        if (event === 'sync-hello') {
            if (serverMode === 'disabled') return answer({ ok: false, error: 'disabled' });
            const ack = () => ({ ok: true, v: 1, serverTime: Date.now(), limits: { maxSubs: 16, maxLimit: 500, gapThreshold: 500 }, results: p.subs.map(snapshot) });
            if (holdHello) return holdHello(p, () => answer(ack()));
            return answer(ack());
        }
        if (event === 'session-subscribe') {
            if (serverMode === 'disabled') return answer({ sid: p.sid, ok: false, error: 'disabled' });
            if (holdSubscribe) return holdSubscribe(p, answer);
            return answer(snapshot(p));
        }
        answer({ ok: true });
    }));
    vi.spyOn(apiSocket, 'request').mockImplementation(async (path, init) => {
        const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
        if (signal) restSignals.push(signal);
        const url = new URL(String(path), 'http://x');
        const sid = url.pathname.split('/')[3];
        gets.push(`${sid}?${url.searchParams.has('after_seq') ? 'after' : 'before'}`);
        if (restGate) await restGate;
        signal?.throwIfAborted();
        const all = server.get(sid)?.messages ?? [];
        const after = url.searchParams.get('after_seq');
        const messages = after !== null ? all.filter((m) => m.seq > Number(after)) : [...all].reverse();
        return new Response(JSON.stringify({ messages, hasMore: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    sync.syncScheduler.disconnected();
    storage.setState({ currentViewingSessionId: null });
});

afterEach(() => {
    sync.syncScheduler.disconnected();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function newSession(): string {
    const sid = `b812-${++counter}`;
    server.set(sid, { messages: [], head: 0 });
    storage.setState((state) => ({
        sessions: {
            ...state.sessions,
            [sid]: { id: sid, presence: 'online', thinking: false, active: true, metadata: { flavor: 'claude', path: '/tmp/x', host: 'h' }, agentState: null } as never,
        },
    }));
    return sid;
}

/** The CLI stored a message (seq = head + 1). */
function store(sid: string, text: string): ServerMessage {
    const session = server.get(sid)!;
    const seq = session.head + 1;
    const message: ServerMessage = {
        id: `${sid}-m${seq}`, seq, localId: null, createdAt: seq, updatedAt: seq,
        content: { t: 'encrypted', c: JSON.stringify({ role: 'user', content: { type: 'text', text } }) },
    };
    session.messages.push(message);
    session.head = seq;
    return message;
}

async function deliver(sid: string, message: ServerMessage) {
    await (sync as unknown as { handleUpdate: (u: unknown) => Promise<void> }).handleUpdate({
        id: `u-${message.id}`, seq: message.seq, createdAt: message.createdAt,
        body: { t: 'new-message', sid, message },
    });
}

const flush = () => vi.advanceTimersByTimeAsync(0);
async function connect() {
    const done = sync.syncScheduler.connect('connect');
    await flush();
    await done;
    await flush();
}
/** The screen mounts: viewing changes (sync.ts wires that edge to scheduler.view in #init — not run here), then onSessionEnter. */
function view(sid: string) {
    const previous = storage.getState().currentViewingSessionId ?? null;
    storage.setState({ currentViewingSessionId: sid });
    sync.syncScheduler.view(previous, sid);
    sync.onSessionEnter(sid);
}
const lastSeq = (sid: string) => (sync as unknown as { cursors: Map<string, { lastSeq?: number }> }).cursors.get(sid)?.lastSeq;
const phase = (sid: string) => sync.syncScheduler.phase(sid)?.phase ?? null;
const subscribes = (sid?: string) => emits.filter((e) => e.event === 'session-subscribe' && (!sid || e.payload.sid === sid));
const hellos = () => emits.filter((e) => e.event === 'sync-hello');
const texts = (sid: string) => (storage.getState().sessionMessages[sid]?.messages ?? [])
    .filter((m) => m.kind === 'user-text')
    .map((m) => (m as { text: string }).text)
    .reverse();

describe('B-812 subscribe mode', () => {
    it('connect negotiates with one hello; opening a session is one subscribe(null) → live, 0 REST', async () => {
        const sid = newSession();
        for (let i = 1; i <= 5; i += 1) store(sid, `m${i}`);
        await connect();
        expect(hellos()).toHaveLength(1);
        expect(sync.syncScheduler.getMode()).toBe('subscribe');
        view(sid);
        await flush();
        expect(subscribes(sid).map((e) => e.payload.afterSeq)).toEqual([null]);
        expect(phase(sid)).toBe('live');
        expect(lastSeq(sid)).toBe(5);
        expect(texts(sid)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
        expect(gets).toEqual([]);
    });

    it('resume sends ONE hello for every subscription; its ack is the catch-up (0 REST)', async () => {
        const a = newSession();
        const b = newSession();
        store(a, 'a1');
        store(b, 'b1');
        await connect();
        view(a);
        await flush();
        view(b);
        await flush();
        emits = [];
        store(a, 'a2'); // arrived while the tab was hidden — its push went into a dead link
        store(b, 'b2');
        sync.syncScheduler.resume();
        await flush();
        expect(hellos()).toHaveLength(1);
        expect(hellos()[0].payload.subs.map((s: { sid: string; afterSeq: number }) => [s.sid, s.afterSeq])).toEqual([[a, 1], [b, 1]]);
        expect(subscribes()).toHaveLength(0);
        expect(texts(a)).toEqual(['a1', 'a2']);
        expect(texts(b)).toEqual(['b1', 'b2']);
        expect(phase(a)).toBe('live');
        expect(gets).toEqual([]);
    });

    it('§9.2-4 N+2 then N+1 inside 400ms → no request; N+2 alone → exactly 1 subscribe after 400ms', async () => {
        const sid = newSession();
        store(sid, 'm1');
        await connect();
        view(sid);
        await flush();
        emits = [];
        const m2 = store(sid, 'm2');
        const m3 = store(sid, 'm3');
        await deliver(sid, m3);
        await vi.advanceTimersByTimeAsync(REORDER_WINDOW_MS - 50);
        await deliver(sid, m2);
        await vi.advanceTimersByTimeAsync(REORDER_WINDOW_MS);
        expect(emits).toEqual([]);
        expect(texts(sid)).toEqual(['m1', 'm2', 'm3']);

        store(sid, 'm4'); // its push is lost
        await deliver(sid, store(sid, 'm5'));
        await vi.advanceTimersByTimeAsync(REORDER_WINDOW_MS - 1);
        expect(subscribes()).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(subscribes().map((e) => e.payload.afterSeq)).toEqual([3]);
        expect(texts(sid)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
        expect(gets).toEqual([]);
    });
});

describe('B-812 seq holes (§9.2-9): live after ONE request, no loop', () => {
    it('tail hole: subscribe(afterSeq=10) answered head 12, no rows → live, lastSeq 12, nothing more for 119s', async () => {
        const sid = newSession();
        for (let i = 1; i <= 10; i += 1) store(sid, `m${i}`);
        await connect();
        view(sid);
        await flush();
        expect(lastSeq(sid)).toBe(10);
        server.get(sid)!.head = 12; // §4.2.1: two seqs allocated, never inserted
        emits = [];
        sync.onSessionEnter(sid);
        await flush();
        expect(subscribes().map((e) => e.payload.afterSeq)).toEqual([10]);
        expect(phase(sid)).toBe('live');
        expect(lastSeq(sid)).toBe(12);
        await vi.advanceTimersByTimeAsync(119_000);
        expect(emits).toHaveLength(1);
        expect(phase(sid)).toBe('live');
        expect(gets).toEqual([]);
        // The next real message (seq 13) is contiguous: shown, no catch-up.
        const m13 = { ...store(sid, 'm13') };
        await deliver(sid, m13);
        await vi.advanceTimersByTimeAsync(REORDER_WINDOW_MS);
        expect(emits).toHaveLength(1);
        expect(texts(sid).at(-1)).toBe('m13');
    });

    it('cold variant: subscribe(null) returns 1–10 with head 12 → live at 12, one request', async () => {
        const sid = newSession();
        for (let i = 1; i <= 10; i += 1) store(sid, `m${i}`);
        server.get(sid)!.head = 12;
        await connect();
        emits = [];
        view(sid);
        await flush();
        expect(phase(sid)).toBe('live');
        expect(lastSeq(sid)).toBe(12);
        await vi.advanceTimersByTimeAsync(119_000);
        expect(subscribes()).toHaveLength(1);
        expect(gets).toEqual([]);
    });

    it('middle hole: a push of N+2 over the hole N+1 → exactly 1 subscribe after 400ms → live, no more requests', async () => {
        const sid = newSession();
        for (let i = 1; i <= 10; i += 1) store(sid, `m${i}`);
        await connect();
        view(sid);
        await flush();
        emits = [];
        server.get(sid)!.head = 11; // seq 11 allocated, never inserted
        const m12 = store(sid, 'm12');
        await deliver(sid, m12);
        await vi.advanceTimersByTimeAsync(REORDER_WINDOW_MS);
        expect(subscribes().map((e) => e.payload.afterSeq)).toEqual([10]);
        expect(phase(sid)).toBe('live');
        expect(lastSeq(sid)).toBe(12);
        await vi.advanceTimersByTimeAsync(119_000);
        expect(emits).toHaveLength(1);
        expect(texts(sid).at(-1)).toBe('m12');
    });
});

describe('B-812 head inconsistency (§9.2-10)', () => {
    it('(a) headSeq < request afterSeq → cache dropped, exactly 1 subscribe(null), then live — no loop', async () => {
        const sid = newSession();
        for (let i = 1; i <= 10; i += 1) store(sid, `m${i}`);
        await connect();
        view(sid);
        await flush();
        // The DB was restored to an earlier point: rows 9–10 and the head are gone.
        const session = server.get(sid)!;
        session.messages = session.messages.slice(0, 8);
        session.head = 8;
        emits = [];
        sync.onSessionEnter(sid);
        await flush();
        expect(subscribes().map((e) => e.payload.afterSeq)).toEqual([10, null]);
        expect(phase(sid)).toBe('live');
        expect(lastSeq(sid)).toBe(8);
        expect(texts(sid)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8']);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(subscribes()).toHaveLength(2);
    });

    it('(b) race: push 11 lands before the ack of a snapshot taken at head 10 → no invalidation, lastSeq 11, live', async () => {
        const sid = newSession();
        for (let i = 1; i <= 10; i += 1) store(sid, `m${i}`);
        await connect();
        view(sid);
        await flush();
        let answerLater: Answer | null = null;
        let snapshotAtRequest: unknown = null;
        holdSubscribe = (payload, answer) => {
            snapshotAtRequest = snapshot(payload); // taken now, at head 10
            answerLater = answer;
        };
        emits = [];
        sync.onSessionEnter(sid);
        await flush();
        expect(subscribes().map((e) => e.payload.afterSeq)).toEqual([10]);
        await deliver(sid, store(sid, 'm11')); // committed after the snapshot began, pushed first
        await flush();
        answerLater!(snapshotAtRequest);
        await flush();
        expect(subscribes()).toHaveLength(1); // no subscribe(null)
        expect(phase(sid)).toBe('live');
        expect(lastSeq(sid)).toBe(11);
        expect(texts(sid).at(-1)).toBe('m11');
        expect(texts(sid)).toHaveLength(11);
    });
});

describe('B-812 legacy fallback (§9.2-5, §6.2-4/7)', () => {
    it('no handler (old server): no ack in 2s → legacy for this connection; open and reconnect use REST like today', async () => {
        serverMode = 'no-handler';
        const sid = newSession();
        store(sid, 'm1');
        storage.setState({ currentViewingSessionId: sid });
        const done = sync.syncScheduler.connect('connect');
        await vi.advanceTimersByTimeAsync(SYNC_FIRST_HELLO_TIMEOUT_MS - 1);
        expect(sync.syncScheduler.getMode()).toBe('negotiating');
        await vi.advanceTimersByTimeAsync(1);
        await done;
        expect(sync.syncScheduler.getMode()).toBe('legacy');
        sync.onSessionEnter(sid);
        await flush();
        expect(subscribes()).toHaveLength(0);
        expect(gets.filter((g) => g.startsWith(sid))).toContain(`${sid}?before`);
        expect(texts(sid)).toEqual(['m1']);
        // Resume in legacy: the REST catch-up (forward), no hello.
        store(sid, 'm2');
        gets = [];
        const before = hellos().length;
        sync.syncScheduler.resume();
        await flush();
        expect(hellos()).toHaveLength(before);
        expect(gets).toEqual([`${sid}?after`]);
        expect(texts(sid)).toEqual(['m1', 'm2']);
    });

    it('a hello-level disabled with no subscriptions → legacy at once: no session-subscribe, lastMode legacy (G1-8)', async () => {
        serverMode = 'disabled';
        // Earlier cases leave subscriptions on the singleton; this one is about a hello that carries none.
        for (const sid of [...(sync.syncScheduler as unknown as { subs: Map<string, unknown> }).subs.keys()]) sync.syncScheduler.forget(sid);
        await connect();
        expect(hellos().map((e) => e.payload.subs.length)).toEqual([0]);
        expect(sync.syncScheduler.getMode()).toBe('legacy');
        expect(localStorage.getItem('vh.sync.lastMode')).toBe('legacy');
        await vi.advanceTimersByTimeAsync(10_000);
        expect(subscribes()).toHaveLength(0);
        expect(hellos()).toHaveLength(1);
    });

    it('an ack that arrives after the 2s deadline is ignored; the next connect negotiates again', async () => {
        let late: Answer | null = null;
        holdHello = (_payload, answer) => { late = answer; };
        const done = sync.syncScheduler.connect('connect');
        await vi.advanceTimersByTimeAsync(SYNC_FIRST_HELLO_TIMEOUT_MS);
        await done;
        expect(sync.syncScheduler.getMode()).toBe('legacy');
        late!(undefined);
        await flush();
        expect(sync.syncScheduler.getMode()).toBe('legacy');
        holdHello = null;
        await connect();
        expect(sync.syncScheduler.getMode()).toBe('subscribe');
    });

    it('disabled (switch off, or an account outside SYNC_SUBSCRIBE_ACCOUNTS) → legacy at once; the viewed session catches up over REST on connect', async () => {
        serverMode = 'disabled';
        const sid = newSession();
        store(sid, 'm1');
        storage.setState({ currentViewingSessionId: sid });
        sync.onSessionEnter(sid); // socket down: REST first page
        await flush();
        expect(gets).toEqual([`${sid}?before`]);
        store(sid, 'm2');
        gets = [];
        await connect();
        expect(sync.syncScheduler.getMode()).toBe('legacy');
        expect(subscribes()).toHaveLength(0);
        expect(gets).toEqual([`${sid}?after`]);
        expect(texts(sid)).toEqual(['m1', 'm2']);
    });

    it('old server: the legacy decision 2s after connect does not abort the first page already on its way (e2e OLDSERVER first screen)', async () => {
        serverMode = 'no-handler';
        const sid = newSession();
        store(sid, 'm1');
        let release!: () => void;
        restGate = new Promise<void>((resolve) => { release = resolve; });
        const done = sync.syncScheduler.connect('connect');
        await flush();
        view(sid);
        await vi.advanceTimersByTimeAsync(NEGOTIATION_REST_DELAY_MS);
        expect(gets).toEqual([`${sid}?before`]);
        // To just past the 2s decision (before the read's own 2s hedge at 2.2s).
        await vi.advanceTimersByTimeAsync(SYNC_FIRST_HELLO_TIMEOUT_MS - NEGOTIATION_REST_DELAY_MS + 50);
        await done;
        expect(sync.syncScheduler.getMode()).toBe('legacy');
        expect(restSignals.some((signal) => signal.aborted)).toBe(false);
        release();
        await flush();
        expect(texts(sid)).toEqual(['m1']);
        expect(gets).toEqual([`${sid}?before`]);
    });

    it('after a legacy connection the next cold open during negotiation fetches at once (speed hint, vh.sync.lastMode)', async () => {
        serverMode = 'no-handler';
        await vi.advanceTimersByTimeAsync(0);
        const first = sync.syncScheduler.connect('connect');
        await vi.advanceTimersByTimeAsync(SYNC_FIRST_HELLO_TIMEOUT_MS);
        await first;
        expect(localStorage.getItem('vh.sync.lastMode')).toBe('legacy');
        const sid = newSession();
        store(sid, 'm1');
        void sync.syncScheduler.connect('connect');
        await flush();
        view(sid);
        await flush();
        expect(gets).toEqual([`${sid}?before`]); // no 200ms wait
        serverMode = 'ok';
        await connect();
        expect(localStorage.getItem('vh.sync.lastMode')).toBe('subscribe');
    });

    it('vh.sync.mode=legacy on this device: no hello at all', async () => {
        localStorage.setItem('vh.sync.mode', 'legacy');
        try {
            await connect();
            expect(hellos()).toHaveLength(0);
            expect(sync.syncScheduler.getMode()).toBe('legacy');
        } finally {
            localStorage.removeItem('vh.sync.mode');
        }
    });

    it('§6.3 a cold open during negotiation does not wait for the hello: REST first page after 200ms in parallel', async () => {
        const sid = newSession();
        store(sid, 'm1');
        let release: Answer | null = null;
        holdHello = (_payload, answer) => { release = answer; };
        const done = sync.syncScheduler.connect('connect');
        await flush();
        view(sid);
        await vi.advanceTimersByTimeAsync(NEGOTIATION_REST_DELAY_MS);
        expect(gets).toEqual([`${sid}?before`]);
        expect(texts(sid)).toEqual(['m1']);
        release!(undefined);
        await flush();
        await done;
        await flush();
        // Then subscribed from the REST anchor, and live.
        expect(subscribes(sid).map((e) => e.payload.afterSeq)).toEqual([1]);
        expect(phase(sid)).toBe('live');
    });
});

describe('B-812 deadlines, errors, reconcile, retention', () => {
    it('resume hello unanswered 5s → stale(timeout), checkLiveness, REST fallback for the viewed session; 「连接不稳定」 at 8s', async () => {
        const sid = newSession();
        store(sid, 'm1');
        await connect();
        view(sid);
        await flush();
        holdHello = () => {};
        store(sid, 'm2');
        gets = [];
        sync.syncScheduler.resume();
        await vi.advanceTimersByTimeAsync(400);
        expect(catchUpStore.getState().sessions[sid]).toBe('syncing');
        expect(gets).toEqual([]);
        // B6: the hello is unanswered after HELLO_HEDGE_MS → the REST catch-up goes out too (the hello stays out).
        await vi.advanceTimersByTimeAsync(HELLO_HEDGE_MS - 400);
        expect(gets).toEqual([`${sid}?after`]);
        expect(texts(sid)).toEqual(['m1', 'm2']);
        expect(phase(sid)).toBe('live');
        expect(catchUpStore.getState().sessions[sid]).toBeUndefined();
        await vi.advanceTimersByTimeAsync(SYNC_ACK_TIMEOUT_MS);
        expect(livenessChecks).toBeGreaterThanOrEqual(1);
        expect(gets).toEqual([`${sid}?after`]); // the deadline's fallback does not repeat the hedge that landed
        expect(phase(sid)).toBe('stale');
        await vi.advanceTimersByTimeAsync(4_000);
        expect(catchUpStore.getState().sessions[sid]).toBeUndefined(); // caught up: no 「连接不稳定」
    });

    it('a session-subscribe unanswered 5s → stale(timeout) + checkLiveness + ONE REST fallback for the viewed session', async () => {
        const sid = newSession();
        store(sid, 'm1');
        await connect();
        view(sid);
        await flush();
        holdSubscribe = () => {};
        store(sid, 'm2');
        gets = [];
        sync.onSessionEnter(sid);
        await vi.advanceTimersByTimeAsync(SYNC_ACK_TIMEOUT_MS - 1);
        expect(gets).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(livenessChecks).toBeGreaterThanOrEqual(1);
        expect(gets).toEqual([`${sid}?after`]);
        expect(texts(sid)).toEqual(['m1', 'm2']);
        expect(phase(sid)).toBe('live');
    });

    it('the deadline fallback does not restart (abort) the hedge REST still on its way', async () => {
        const sid = newSession();
        store(sid, 'm1');
        await connect();
        view(sid);
        await flush();
        holdHello = () => {};
        let release!: () => void;
        restGate = new Promise<void>((resolve) => { release = resolve; });
        store(sid, 'm2');
        gets = [];
        sync.syncScheduler.resume();
        await vi.advanceTimersByTimeAsync(HELLO_HEDGE_MS);
        expect(gets).toEqual([`${sid}?after`]);
        await vi.advanceTimersByTimeAsync(SYNC_ACK_TIMEOUT_MS);
        expect(restSignals.some((signal) => signal.aborted)).toBe(false);
        release();
        await flush();
        expect(texts(sid)).toEqual(['m1', 'm2']);
    });

    it('a slow ack shows 「同步中」 after 300ms and clears it when live', async () => {
        const sid = newSession();
        store(sid, 'm1');
        await connect();
        view(sid);
        await flush();
        let release: (() => void) | null = null;
        holdHello = (_payload, answer) => { release = () => answer(undefined); };
        sync.syncScheduler.resume();
        await vi.advanceTimersByTimeAsync(299);
        expect(catchUpStore.getState().sessions[sid]).toBeUndefined();
        await vi.advanceTimersByTimeAsync(2);
        expect(catchUpStore.getState().sessions[sid]).toBe('syncing');
        release!();
        await flush();
        expect(phase(sid)).toBe('live');
        expect(catchUpStore.getState().sessions[sid]).toBeUndefined();
    });

    it('unavailable ×3 (1s, 2s backoff) → stale(server) and ONE REST fallback', async () => {
        const sid = newSession();
        store(sid, 'm1');
        await connect();
        view(sid);
        await flush();
        holdSubscribe = (payload, answer) => answer({ sid: payload.sid, ok: false, error: 'unavailable' });
        emits = [];
        gets = [];
        sync.onSessionEnter(sid);
        await flush();
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(subscribes()).toHaveLength(3);
        expect(gets).toEqual([`${sid}?after`]);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(subscribes()).toHaveLength(3);
    });

    it('§9.2-5 r2: an unknown error code is unavailable — 1s, 2s backoff → stale(server) and ONE REST fallback', async () => {
        const sid = newSession();
        store(sid, 'm1');
        await connect();
        view(sid);
        await flush();
        holdSubscribe = (payload, answer) => answer({ sid: payload.sid, ok: false, error: 'foo' });
        emits = [];
        gets = [];
        sync.onSessionEnter(sid);
        await flush();
        expect(subscribes()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(999);
        expect(subscribes()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(subscribes()).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(subscribes()).toHaveLength(3);
        expect(phase(sid)).toBe('live'); // the REST fallback caught it up (legacy-strength)
        expect(gets).toEqual([`${sid}?after`]);
        expect(sync.syncScheduler.getMode()).toBe('subscribe'); // not a legacy error
        await vi.advanceTimersByTimeAsync(10_000);
        expect(subscribes()).toHaveLength(3);
    });

    it('§9.2-5 r2: an empty page with hasMore (budget exhausted) asks again from the same afterSeq; a cold one asks cold again', async () => {
        const sid = newSession();
        for (let i = 1; i <= 3; i += 1) store(sid, `m${i}`);
        await connect();
        view(sid);
        await flush();
        expect(lastSeq(sid)).toBe(3);
        store(sid, 'm4');
        store(sid, 'm5');
        let starved = 1;
        holdSubscribe = (payload, answer) => {
            if (starved-- > 0) return answer({ sid: payload.sid, ok: true, headSeq: server.get(payload.sid)!.head, messages: [], hasMore: true });
            answer(snapshot(payload));
        };
        emits = [];
        sync.onSessionEnter(sid);
        await flush();
        expect(subscribes(sid).map((e) => e.payload.afterSeq)).toEqual([3, 3]);
        expect(phase(sid)).toBe('live');
        expect(texts(sid)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
        expect(gets).toEqual([]);

        // Cold: the first page itself came back empty with hasMore.
        const cold = newSession();
        store(cold, 'c1');
        starved = 1;
        emits = [];
        view(cold);
        await flush();
        expect(subscribes(cold).map((e) => e.payload.afterSeq)).toEqual([null, null]);
        expect(phase(cold)).toBe('live');
        expect(texts(cold)).toEqual(['c1']);
    });

    it('a connect / recovered / handover hello is never hedged with REST (a switch-over storm must not fan out reads)', async () => {
        const sid = newSession();
        store(sid, 'm1');
        await connect();
        view(sid);
        await flush();
        holdHello = () => {};
        store(sid, 'm2');
        gets = [];
        for (const reason of ['connect', 'recovered', 'handover'] as const) {
            void sync.syncScheduler.connect(reason);
            await vi.advanceTimersByTimeAsync(HELLO_HEDGE_MS + 200);
            expect({ reason, gets }).toEqual({ reason, gets: [] });
        }
        // The resume hello is (B6) — the same wait does fan out.
        sync.syncScheduler.resume();
        await vi.advanceTimersByTimeAsync(HELLO_HEDGE_MS + 200);
        expect(gets).toEqual([`${sid}?after`]);
    });

    it('S12: an ack for a session whose key is not here yet merges once the FIRST session list landed, not after the queued second list fetch', async () => {
        const internals = sync as unknown as {
            sessionsSync: { awaitQueue: () => Promise<void> };
            firstSessionsList: { settled: boolean; promise: Promise<void>; resolve: () => void };
            encryption: { getSessionEncryption: (id: string) => unknown };
        };
        const sid = newSession();
        store(sid, 'm1');
        const realEncryption = internals.encryption;
        const realFirst = internals.firstSessionsList;
        let keys = false;
        internals.encryption = { getSessionEncryption: (id: string) => (keys ? realEncryption.getSessionEncryption(id) : null) };
        let resolveFirst!: () => void;
        const first = { settled: false, promise: new Promise<void>((r) => { resolveFirst = r; }), resolve: () => { first.settled = true; resolveFirst(); } };
        internals.firstSessionsList = first;
        // The second full list download (queued by the first connect) ends only when the test says so.
        let finishQueue!: () => void;
        const queued = new Promise<void>((r) => { finishQueue = r; });
        const queue = vi.spyOn(internals.sessionsSync, 'awaitQueue').mockImplementation(() => queued);
        try {
            await connect();
            view(sid);
            await flush();
            expect(subscribes(sid)).toHaveLength(1);
            expect(texts(sid)).toEqual([]); // waiting for the key
            keys = true;
            first.resolve(); // fetchSessions applied the first list
            await flush();
            expect(texts(sid)).toEqual(['m1']);
            expect(phase(sid)).toBe('live');
            expect(queue).toHaveBeenCalled();
            // After the first list: a session it did not carry still waits for the queue (as before).
            keys = false;
            const late = newSession();
            store(late, 'l1');
            view(late);
            await flush();
            expect(texts(late)).toEqual([]);
            keys = true;
            finishQueue(); // the refetch that carried it
            await flush();
            expect(texts(late)).toEqual(['l1']);
            expect(subscribes(late)).toHaveLength(1); // merged on the first ack, not after a failed one + backoff
        } finally {
            internals.encryption = realEncryption;
            internals.firstSessionsList = realFirst;
        }
    });

    it('120s reconcile: one empty subscribe while live, visible and viewed; none for a session left in the background', async () => {
        const a = newSession();
        const b = newSession();
        store(a, 'a1');
        store(b, 'b1');
        await connect();
        view(b);
        await flush();
        view(a);
        await flush();
        emits = [];
        await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS);
        expect(subscribes().map((e) => [e.payload.sid, e.payload.afterSeq])).toEqual([[a, 1]]);
        (document as { visibilityState: string }).visibilityState = 'hidden';
        try {
            await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS);
            expect(subscribes()).toHaveLength(1);
        } finally {
            (document as { visibilityState: string }).visibilityState = 'visible';
        }
    });

    it('leaving a session keeps its subscription 5 minutes, then session-unsubscribe; at most 8, least recently viewed out', async () => {
        await connect();
        const first = newSession();
        store(first, 'x');
        view(first);
        await flush();
        const second = newSession();
        store(second, 'y');
        view(second);
        await flush();
        expect(sync.syncScheduler.isSubscribed(first)).toBe(true);
        await vi.advanceTimersByTimeAsync(SUBSCRIPTION_RETAIN_MS);
        expect(sync.syncScheduler.isSubscribed(first)).toBe(false);
        expect(emits.filter((e) => e.event === 'session-unsubscribe').map((e) => e.payload.sid)).toEqual([first]);

        const opened: string[] = [];
        for (let i = 0; i < MAX_SUBSCRIPTIONS; i += 1) { // + `second` = one over the cap
            const sid = newSession();
            store(sid, 'z');
            view(sid);
            await flush();
            opened.push(sid);
            await vi.advanceTimersByTimeAsync(10);
        }
        expect(sync.syncScheduler.isSubscribed(second)).toBe(false); // least recently viewed
        expect(opened.every((sid) => sync.syncScheduler.isSubscribed(sid))).toBe(true);
    });

    it('a session re-subscribed after its retention ran out goes live again (generations restart with the subscription)', async () => {
        const a = newSession();
        const b = newSession();
        store(a, 'a1');
        store(b, 'b1');
        await connect();
        view(a);
        await flush();
        await connect(); // a reconnect bumps the generation of every subscription (a: 1)
        view(b);
        await vi.advanceTimersByTimeAsync(SUBSCRIPTION_RETAIN_MS);
        expect(sync.syncScheduler.isSubscribed(a)).toBe(false);
        store(a, 'a2');
        view(a);
        await flush();
        expect(phase(a)).toBe('live');
        expect(texts(a)).toEqual(['a1', 'a2']);
    });

    it('a handover candidate keeps the old socket until its hello settled (the reconnected listener returns it)', async () => {
        const sid = newSession();
        store(sid, 'm1');
        await connect();
        view(sid);
        await flush();
        let release: (() => void) | null = null;
        holdHello = (_payload, answer) => { release = () => answer(undefined); };
        let settled = false;
        const handover = sync.syncScheduler.connect('handover').then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(500);
        expect(settled).toBe(false);
        release!();
        await handover;
        expect(settled).toBe(true);
        expect(sync.syncScheduler.getMode()).toBe('subscribe');
    });

    it('not_found removes the subscription', async () => {
        const sid = newSession();
        store(sid, 'm1');
        await connect();
        view(sid);
        await flush();
        server.delete(sid);
        sync.onSessionEnter(sid);
        await flush();
        expect(sync.syncScheduler.isSubscribed(sid)).toBe(false);
    });

    it('socket down → the REST path for resume and gaps (it often works while the socket reconnects)', async () => {
        const sid = newSession();
        store(sid, 'm1');
        await connect();
        view(sid);
        await flush();
        connected = false;
        sync.syncScheduler.disconnected();
        store(sid, 'm2');
        gets = [];
        sync.syncScheduler.resume();
        await flush();
        expect(gets).toEqual([`${sid}?after`]);
        expect(phase(sid)).toBe('stale');
        // Reconnect: hello proves the head → live.
        connected = true;
        await connect();
        expect(phase(sid)).toBe('live');
    });
});

describe('B-812 spec constants (§5.2; the behaviour tests read them, so pin the values)', () => {
    it('120s reconcile, 8 subscriptions, 5 min retention, 600ms resume-hello hedge', () => {
        expect(RECONCILE_INTERVAL_MS).toBe(120_000);
        expect(MAX_SUBSCRIPTIONS).toBe(8);
        expect(SUBSCRIPTION_RETAIN_MS).toBe(300_000);
        expect(HELLO_HEDGE_MS).toBe(600);
        expect(REORDER_WINDOW_MS).toBe(400);
    });
});

describe('B-812 wiring in sync.ts', () => {
    it('S12: fetchSessions signals the first list once it is applied', async () => {
        const { readFileSync } = await import('node:fs');
        const source = readFileSync(new URL('./sync.ts', import.meta.url), 'utf8');
        expect(source).toMatch(/this\.applySessions\(mergedSessions\);\s*log\.log\(`📥 fetchSessions completed[^\n]*\n\s*this\.firstSessionsList\.resolve\(\);/);
    });

    it('the viewed-session edge reaches the scheduler (retention), and socket loss marks subscriptions stale', async () => {
        const { readFileSync } = await import('node:fs');
        const source = readFileSync(new URL('./sync.ts', import.meta.url), 'utf8');
        expect(source).toContain('this.syncScheduler.view(prev.currentViewingSessionId ?? null, state.currentViewingSessionId ?? null);');
        expect(source).toContain("if (status !== 'connected' && this.syncScheduler.getMode() !== 'down') this.syncScheduler.disconnected();");
    });
});

/**
 * B-812 M1 (REVIEW-757): when the link comes back (reconnect / recovered /
 * resume) or control returns, the viewed session's duties — warm the machine
 * relay, the yolo alignment, voice focus — run in EVERY sync mode, as
 * `catchUpViewedSession → onSessionEnter` did on main. Through Sync's own
 * handlers (subscribeToUpdates wires them once; this block runs last).
 */
describe('B-812 M1: the session duties survive every link-back edge in every mode', () => {
    let wired = false;
    let relays: string[];
    let focuses: string[];
    beforeEach(async () => {
        if (!wired) {
            (sync as unknown as { subscribeToUpdates: () => void }).subscribeToUpdates();
            wired = true;
        }
        relays = [];
        focuses = [];
        vi.spyOn(apiSocket, 'prepareMachineRelay').mockImplementation((machineId: string) => { relays.push(machineId); });
        const { voiceHooks } = await import('@/realtime/hooks/voiceHooks');
        vi.spyOn(voiceHooks, 'onSessionFocus').mockImplementation((sid: string) => { focuses.push(sid); });
    });

    function viewedSession(): string {
        const sid = newSession();
        store(sid, 'm1');
        storage.setState((state) => ({
            sessions: { ...state.sessions, [sid]: { ...state.sessions[sid], metadata: { ...state.sessions[sid].metadata, machineId: `machine-${sid}` } } as never },
            currentViewingSessionId: sid,
        }));
        return sid;
    }
    const listeners = (name: 'reconnectedListeners' | 'recoveredListeners') => {
        const set = (apiSocket as unknown as Record<string, Set<() => unknown>>)[name];
        expect(set.size).toBeGreaterThan(0);
        return [...set];
    };
    const reconnected = async () => { await Promise.all(listeners('reconnectedListeners').map((listener) => listener())); await flush(); };
    const recovered = async () => { for (const listener of listeners('recoveredListeners')) listener(); await flush(); };
    const resume = async () => { (sync as unknown as { onWebResume: () => void }).onWebResume(); await flush(); };

    for (const mode of ['ok', 'disabled'] as const) {
        const label = mode === 'ok' ? 'subscribe mode' : 'legacy (not on SYNC_SUBSCRIBE_ACCOUNTS)';
        it(`${label}: reconnect, recovered and resume each warm the relay and refocus voice once`, async () => {
            serverMode = mode;
            const sid = viewedSession();
            await connect();
            sync.onSessionEnter(sid);
            await flush();
            expect(sync.syncScheduler.getMode()).toBe(mode === 'ok' ? 'subscribe' : 'legacy');
            for (const edge of [reconnected, recovered, resume]) {
                relays = [];
                focuses = [];
                await edge();
                expect({ edge: edge.name, relays, focuses }).toEqual({ edge: edge.name, relays: [`machine-${sid}`], focuses: [sid] });
            }
        });
    }

    it('G1-29: Sync\'s reconnected listener returns the hello, so a release handover keeps the old socket until it settled', async () => {
        const sid = viewedSession();
        await connect();
        sync.onSessionEnter(sid);
        await flush();
        let release: (() => void) | null = null;
        holdHello = (_payload, answer) => { release = () => answer(undefined); };
        const returned = listeners('reconnectedListeners').map((listener) => listener()).filter((value) => value instanceof Promise) as Promise<unknown>[];
        expect(returned.length).toBeGreaterThan(0);
        let settled = false;
        const all = Promise.all(returned).then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(500);
        expect(settled).toBe(false);
        release!();
        await all;
        expect(settled).toBe(true);
    });

    it('control returned to this device: the session duties run with the catch-up (subscribe and legacy)', async () => {
        for (const mode of ['ok', 'disabled'] as const) {
            serverMode = mode;
            const sid = viewedSession();
            await connect();
            sync.onSessionEnter(sid);
            await flush();
            const encryption = (sync as unknown as { encryption: { getSessionEncryption: (id: string) => any } }).encryption;
            const base = encryption.getSessionEncryption(sid);
            (sync as unknown as { encryption: unknown }).encryption = {
                getSessionEncryption: (id: string) => (server.has(id) ? { ...base, decryptAgentState: async (_v: number, value: string) => JSON.parse(value) } : null),
            };
            storage.setState((state) => ({ sessions: { ...state.sessions, [sid]: { ...state.sessions[sid], agentState: { controlledByUser: false } } as never } }));
            relays = [];
            focuses = [];
            await (sync as unknown as { handleUpdate: (u: unknown) => Promise<void> }).handleUpdate({
                id: `u-control-${sid}`, seq: 1, createdAt: 1,
                body: { t: 'update-session', id: sid, agentState: { version: 2, value: JSON.stringify({ controlledByUser: true }) } },
            });
            await flush();
            expect({ mode, relays, focuses }).toEqual({ mode, relays: [`machine-${sid}`], focuses: [sid] });
        }
    });
});
