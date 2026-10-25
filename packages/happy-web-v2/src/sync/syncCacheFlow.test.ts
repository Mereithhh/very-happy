/**
 * B-813 (spec B-807 §5.4 / §5.4.2): the message cache inside the real
 * Sync.fetchMessages against a fake server (same harness as
 * liveMessageSync.test.ts) and fake-indexeddb.
 *
 * The one property every case pins: whatever the cache holds, the
 * transcript ends up equal to the server's history. A good cache only makes
 * the first paint come before the network; a bad one costs one cold load.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import type { StoredRow } from './cache/syncCache';
import { REORDER_WINDOW_MS } from './sessionMerge';

let sync: typeof import('./sync').sync;
let storage: typeof import('./storage').storage;
let apiSocket: typeof import('./apiSocket').apiSocket;
let syncCache: typeof import('./cache/syncCache').syncCache;

type ServerMessage = { id: string; seq: number; localId: null; content: { t: 'encrypted'; c: string }; createdAt: number; updatedAt: number };

let server: Map<string, ServerMessage[]>;
let gets: string[];
let afterSeqs: number[];
let counter = 0;
/** While set, after_seq requests wait for it (the network is slow; the cache is not). */
let afterGate: Promise<void> | null;
let failAfter: number;
let forgotten: string[];
/** While set, every decryption waits for it (a slow device renders the cached run slowly; the network is not held). */
let decryptGate: Promise<void> | null;
/** after_seq answers with the history as it was when the request ARRIVED (a gated answer is late, not newer). */
let snapshotAtRequest: boolean;
/** When set, an after_seq page holds at most this many rows (hasMore = more remain). */
let forwardPageLimit: number | null;

beforeAll(async () => {
    installBrowserTestGlobals();
    ({ sync } = await import('./sync'));
    ({ storage } = await import('./storage'));
    ({ apiSocket } = await import('./apiSocket'));
    ({ syncCache } = await import('./cache/syncCache'));
});

function decrypt(message: ServerMessage) {
    let content: unknown = null;
    try { content = JSON.parse(message.content.c); } catch { content = null; }
    return { id: message.id, seq: message.seq, localId: null, createdAt: message.createdAt, content };
}

beforeEach(async () => {
    server = new Map();
    gets = [];
    afterSeqs = [];
    afterGate = null;
    failAfter = 0;
    forgotten = [];
    decryptGate = null;
    snapshotAtRequest = false;
    forwardPageLimit = null;
    const encryption = {
        decryptMessage: async (message: ServerMessage) => decrypt(message),
        decryptMessages: async (messages: ServerMessage[]) => {
            if (decryptGate) await decryptGate;
            return messages.map(decrypt);
        },
        forgetMessages: (ids: string[]) => { forgotten.push(...ids); },
    };
    (sync as unknown as { encryption: unknown }).encryption = { getSessionEncryption: (id: string) => (server.has(id) ? encryption : null), removeSessionEncryption: () => {} };
    vi.spyOn(apiSocket, 'request').mockImplementation(async (path) => {
        const url = new URL(String(path), 'http://x');
        const sid = url.pathname.split('/')[3];
        const all = server.get(sid) ?? [];
        const after = url.searchParams.get('after_seq');
        gets.push(`${sid}?${after !== null ? 'after' : 'before'}`);
        const early = snapshotAtRequest && after !== null ? all.filter((m) => m.seq > Number(after)) : null;
        if (after !== null) {
            afterSeqs.push(Number(after));
            if (afterGate) await afterGate;
            if (failAfter > 0) {
                failAfter -= 1;
                throw new DOMException('read deadline', 'TimeoutError');
            }
        }
        let messages = early ?? (after !== null ? all.filter((m) => m.seq > Number(after)) : [...all].reverse());
        let hasMore = false;
        if (after !== null && forwardPageLimit !== null && messages.length > forwardPageLimit) {
            messages = messages.slice(0, forwardPageLimit);
            hasMore = true;
        }
        return new Response(JSON.stringify({ messages, hasMore }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    await syncCache.open(`flow-account-${++counter}`);
});

afterEach(() => {
    vi.restoreAllMocks();
});

function newSession(): string {
    const sid = `b813-${++counter}`;
    server.set(sid, []);
    storage.setState((state) => ({
        sessions: {
            ...state.sessions,
            [sid]: { id: sid, presence: 'online', thinking: false, active: true, metadata: { flavor: 'claude', path: '/tmp/x', host: 'h' }, agentState: null } as never,
        },
    }));
    return sid;
}

/** `skip`: seqs left unused before this one — an old session's permanent seq hole (spec r1 §4.2.1). */
function store(sid: string, text: string, id?: string, skip = 0): ServerMessage {
    const list = server.get(sid)!;
    const seq = (list.at(-1)?.seq ?? 0) + 1 + skip;
    const message: ServerMessage = {
        id: id ?? `${sid}-m${seq}`, seq, localId: null, createdAt: seq, updatedAt: seq,
        content: { t: 'encrypted', c: JSON.stringify({ role: 'user', content: { type: 'text', text } }) },
    };
    list.push(message);
    return message;
}

async function settle() {
    for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** B-812: past the reorder window (real timers), then settled. */
async function reorderWindow() {
    await new Promise((resolve) => setTimeout(resolve, REORDER_WINDOW_MS + 20));
    await settle();
}

const texts = (sid: string) => (storage.getState().sessionMessages[sid]?.messages ?? [])
    .filter((m) => m.kind === 'user-text')
    .map((m) => (m as { text: string }).text)
    .reverse();
const serverTexts = (sid: string) => server.get(sid)!.map((m) => JSON.parse(m.content.c).content.text as string);

/** A page reload, as far as this session is concerned: memory forgets it, IndexedDB keeps it. */
function reload(sid: string) {
    const s = sync as unknown as Record<string, { delete?: (k: string) => void; clear?: (k: string) => void }>;
    // B-812: lastSeq / oldestSeq / the pre-anchor buffer live in the merge cursor.
    s.cursors.delete!(sid);
    s.messagesSync.delete!(sid);
    s.unverifiedCacheHits.delete!(sid);
    storage.getState().resetSessionMessages(sid);
}

/** First visit: the latest page loads from the network and lands in the cache. */
async function visit(sid: string) {
    sync.onSessionEnter(sid);
    await settle();
    await syncCache.flush();
}

/** Every batch the reducer receives for `sid`, as server seqs. */
function recordApplied(sid: string): number[][] {
    const batches: number[][] = [];
    // B-812: the one store writer (mergeSessionMessages / optimistic inputs).
    const s = sync as unknown as { writeMessagesToStore: (id: string, messages: Array<{ seq?: number }>, ...rest: unknown[]) => void };
    const original = s.writeMessagesToStore;
    vi.spyOn(s, 'writeMessagesToStore').mockImplementation((id, messages, ...rest) => {
        if (id === sid) batches.push(messages.map((m) => m.seq!));
        original(id, messages, ...rest);
    });
    return batches;
}

/** Each batch ascending, and every batch past everything applied before it (iron rule 15 across batches). */
function expectMonotonic(batches: number[][]) {
    let max = 0;
    for (const batch of batches) {
        for (const seq of batch) {
            expect(seq, JSON.stringify(batches)).toBeGreaterThan(max);
            max = seq;
        }
    }
}

const isPrefix = (part: string[], whole: string[]) => part.every((text, i) => whole[i] === text);

async function pushLive(sid: string, message: ServerMessage) {
    await (sync as unknown as { handleUpdate: (u: unknown) => Promise<void> }).handleUpdate({
        id: `u-${message.id}`, seq: message.seq, createdAt: message.createdAt, body: { t: 'new-message', sid, message },
    });
}

function gate() {
    let release!: () => void;
    afterGate = new Promise<void>((resolve) => { release = resolve; });
    return () => { afterGate = null; release(); };
}

function gateDecrypt() {
    let release!: () => void;
    decryptGate = new Promise<void>((resolve) => { release = resolve; });
    return () => { decryptGate = null; release(); };
}

async function rawCacheTx(fn: (tx: IDBTransaction) => void) {
    const name = (await indexedDB.databases()).map((db) => db.name!).filter((n) => n.startsWith('vh-sync-')).pop()!;
    const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); });
    // The newest database is this test's account (the cache already holds a connection; reads and writes interleave fine).
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['messages', 'sessions'], 'readwrite');
        fn(tx);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    db.close();
}

describe('B-813 cold start: cache first, then catch up from its lastSeq', () => {
    it('renders the cached run before any request answers, then catches up with ONE after_seq GET from lastSeq - 1', async () => {
        const sid = newSession();
        for (let i = 1; i <= 3; i++) store(sid, `m${i}`);
        await visit(sid);
        expect(gets).toEqual([`${sid}?before`]);

        store(sid, 'm4');
        store(sid, 'm5');
        reload(sid);
        gets = [];
        const release = gate();
        sync.onSessionEnter(sid);
        await settle();
        // Network still pending: the cached transcript is already there.
        expect(texts(sid)).toEqual(['m1', 'm2', 'm3']);
        expect(storage.getState().sessionMessages[sid]?.isLoaded).toBe(true);
        const applied = recordApplied(sid);
        release();
        await settle();
        expect(texts(sid)).toEqual(serverTexts(sid));
        expect(gets).toEqual([`${sid}?after`]);
        expect(afterSeqs).toEqual([2]);
        // §9.2-6(c): the probe page starts at the cached newest row; only what is past it merges.
        expect(applied).toEqual([[4, 5]]);

        // The catch-up extended the cache: the next reload starts at 5.
        await syncCache.flush();
        expect((await syncCache.load(sid))?.lastSeq).toBe(5);
    });

    it('a session the cache does not have goes straight to the network (no IndexedDB read first)', async () => {
        const sid = newSession();
        store(sid, 'm1');
        const load = vi.spyOn(syncCache, 'load');
        sync.onSessionEnter(sid);
        await settle();
        expect(load).not.toHaveBeenCalled();
        expect(gets).toEqual([`${sid}?before`]);
        expect(texts(sid)).toEqual(['m1']);
    });

    it('while the session key is still loading, the cached run is read in parallel and used once it is there', async () => {
        const sid = newSession();
        for (let i = 1; i <= 3; i++) store(sid, `m${i}`);
        await visit(sid);
        reload(sid);
        const sessionEncryption = (sync as unknown as { encryption: { getSessionEncryption: (id: string) => unknown } }).encryption;
        const getKey = sessionEncryption.getSessionEncryption;
        let keyReady = false;
        sessionEncryption.getSessionEncryption = (id: string) => (keyReady ? getKey(id) : null);
        const load = vi.spyOn(syncCache, 'load');
        try {
            sync.onSessionEnter(sid); // fails: no key yet — the read starts anyway
            await settle();
            expect(load).toHaveBeenCalledTimes(1);
            expect(texts(sid)).toEqual([]);
            keyReady = true;
            sync.onSessionEnter(sid);
            await vi.waitFor(() => expect(texts(sid)).toEqual(['m1', 'm2', 'm3']), { timeout: 5_000 });
            expect(load).toHaveBeenCalledTimes(1);
            expect(syncCache.stats().hits).toBeGreaterThanOrEqual(1);
        } finally {
            sessionEncryption.getSessionEncryption = getKey;
        }
    });

    it('live pushes keep the cache current (no network needed on the next reload beyond one probe)', async () => {
        const sid = newSession();
        store(sid, 'm1');
        await visit(sid);
        for (let i = 2; i <= 4; i++) {
            const message = store(sid, `m${i}`);
            await (sync as unknown as { handleUpdate: (u: unknown) => Promise<void> }).handleUpdate({
                id: `u-${message.id}`, seq: message.seq, createdAt: message.createdAt, body: { t: 'new-message', sid, message },
            });
        }
        await settle();
        await syncCache.flush();
        reload(sid);
        gets = [];
        sync.onSessionEnter(sid);
        await settle();
        expect(texts(sid)).toEqual(['m1', 'm2', 'm3', 'm4']);
        expect(afterSeqs).toEqual([3]);
    });
});

describe('B-819 (QA8 F2): the anchor probe overlaps the cache render and the key wait', () => {
    it('the probe request is out while the cached run is still decrypting — not one round trip after the render', async () => {
        const sid = newSession();
        for (let i = 1; i <= 3; i++) store(sid, `m${i}`);
        await visit(sid);
        store(sid, 'm4');
        reload(sid);
        afterSeqs = [];
        const applied = recordApplied(sid);
        const release = gateDecrypt();
        sync.onSessionEnter(sid);
        await settle();
        // Before B-819: [] — the probe waited for the render.
        expect(afterSeqs).toEqual([2]);
        expect(texts(sid)).toEqual([]);
        release();
        await settle();
        expect(texts(sid)).toEqual(serverTexts(sid));
        expect(afterSeqs).toEqual([2]);
        // The probe answered while the run decrypted: checked first, then ONE commit up to the newest message.
        expect(applied).toEqual([[1, 2, 3, 4]]);
    });

    it('a probe merged with the render that says hasMore → the catch-up goes on from its newest row', async () => {
        const sid = newSession();
        for (let i = 1; i <= 3; i++) store(sid, `m${i}`);
        await visit(sid);
        for (let i = 4; i <= 6; i++) store(sid, `m${i}`);
        reload(sid);
        afterSeqs = [];
        forwardPageLimit = 2; // the probe (after 2) gets m3, m4 and hasMore
        const applied = recordApplied(sid);
        const release = gateDecrypt();
        sync.onSessionEnter(sid);
        await settle();
        expect(afterSeqs).toEqual([2]);
        release();
        await settle();
        expect(texts(sid)).toEqual(serverTexts(sid));
        expect(afterSeqs).toEqual([2, 4]);
        expect(applied).toEqual([[1, 2, 3, 4], [5, 6]]);
    });

    it('a probe that answered before the render and contradicts the cache → the stale run is never painted, cold page', async () => {
        const sid = newSession();
        for (let i = 1; i <= 3; i++) store(sid, `m${i}`);
        await visit(sid);
        server.set(sid, []);
        for (let i = 1; i <= 4; i++) store(sid, `n${i}`, `recreated-${i}`);
        reload(sid);
        gets = [];
        const mismatches = syncCache.stats().drops.mismatch ?? 0;
        const applied = recordApplied(sid);
        const release = gateDecrypt();
        sync.onSessionEnter(sid);
        await settle();
        release();
        await settle();
        expect(texts(sid)).toEqual(['n1', 'n2', 'n3', 'n4']);
        // One batch: the cold page (newest-first from the server). Before: the cached m1..m3 painted, then reset.
        expect(applied.map((batch) => [...batch].sort())).toEqual([[1, 2, 3, 4]]);
        expect(gets).toEqual([`${sid}?after`, `${sid}?before`]);
        expect(syncCache.stats().drops.mismatch).toBe(mismatches + 1);
    });

    it('while the key loads, the probe goes out with the cache read; the session list wakes the catch-up at once', async () => {
        const sid = newSession();
        for (let i = 1; i <= 3; i++) store(sid, `m${i}`);
        await visit(sid);
        store(sid, 'm4');
        reload(sid);
        afterSeqs = [];
        const sessionEncryption = (sync as unknown as { encryption: { getSessionEncryption: (id: string) => unknown } }).encryption;
        const getKey = sessionEncryption.getSessionEncryption;
        let keyReady = false;
        sessionEncryption.getSessionEncryption = (id: string) => (keyReady ? getKey(id) : null);
        try {
            sync.onSessionEnter(sid); // no key: fails, sleeps in backoff (≥125ms)
            await settle();
            // Before B-819: [] — nothing asked until the key was there and the run rendered.
            expect(afterSeqs).toEqual([2]);
            expect(texts(sid)).toEqual([]);
            // The session list lands: keys first, then applySessions (fetchSessions).
            keyReady = true;
            (sync as unknown as { applySessions: (s: unknown[]) => void }).applySessions([storage.getState().sessions[sid]]);
            await settle();
            // Before B-819: still [] here — the retry slept out its backoff.
            expect(texts(sid)).toEqual(serverTexts(sid));
            // The early probe served the catch-up: no second request.
            expect(afterSeqs).toEqual([2]);
        } finally {
            sessionEncryption.getSessionEncryption = getKey;
        }
    });

    it('a prefetch that missed only because the database was still opening is read again once the key is here', async () => {
        const sid = newSession();
        for (let i = 1; i <= 3; i++) store(sid, `m${i}`);
        await visit(sid);
        reload(sid);
        const sessionEncryption = (sync as unknown as { encryption: { getSessionEncryption: (id: string) => unknown } }).encryption;
        const getKey = sessionEncryption.getSessionEncryption;
        let keyReady = false;
        sessionEncryption.getSessionEncryption = (id: string) => (keyReady ? getKey(id) : null);
        const load = syncCache.load.bind(syncCache);
        // The early read finds the database not open yet (a cold page under load) → null.
        const spy = vi.spyOn(syncCache, 'load').mockImplementationOnce(async () => null).mockImplementation(load);
        gets = [];
        try {
            sync.onSessionEnter(sid);
            await settle();
            keyReady = true;
            (sync as unknown as { applySessions: (x: unknown[]) => void }).applySessions([storage.getState().sessions[sid]]);
            await settle();
            expect(texts(sid)).toEqual(['m1', 'm2', 'm3']);
            // Before: the miss was reused — no cache, a cold page instead.
            expect(spy).toHaveBeenCalledTimes(2);
            expect(gets).toEqual([`${sid}?after`]);
        } finally {
            sessionEncryption.getSessionEncryption = getKey;
        }
    });

    it('a key that arrives while the cache is still opening does not wait for it: the network page, no cache read awaited', async () => {
        const sid = newSession();
        for (let i = 1; i <= 3; i++) store(sid, `m${i}`);
        await visit(sid);
        store(sid, 'm4');
        reload(sid);
        const sessionEncryption = (sync as unknown as { encryption: { getSessionEncryption: (id: string) => unknown } }).encryption;
        const getKey = sessionEncryption.getSessionEncryption;
        let keyReady = false;
        sessionEncryption.getSessionEncryption = (id: string) => (keyReady ? getKey(id) : null);
        let openDb!: () => void;
        const opening = new Promise<void>((resolve) => { openDb = resolve; });
        const load = syncCache.load.bind(syncCache);
        // A slow device: the database open (inside load) has not finished when the session list lands.
        vi.spyOn(syncCache, 'load').mockImplementationOnce(async (...args) => { await opening; return load(...args); });
        gets = [];
        try {
            sync.onSessionEnter(sid);
            await settle();
            keyReady = true;
            (sync as unknown as { applySessions: (x: unknown[]) => void }).applySessions([storage.getState().sessions[sid]]);
            await settle();
            // Before: nothing until the database opened — the cache made the open slower than no cache.
            expect(texts(sid)).toEqual(serverTexts(sid));
            expect(gets).toEqual([`${sid}?before`]);
        } finally {
            openDb();
            sessionEncryption.getSessionEncryption = getKey;
        }
    });

    it('a cold open on /session/:id starts the catch-up with the session list — rendered when the keys land, before the screen mounts', async () => {
        const sid = newSession();
        for (let i = 1; i <= 3; i++) store(sid, `m${i}`);
        await visit(sid);
        store(sid, 'm4');
        reload(sid);
        afterSeqs = [];
        const sessionEncryption = (sync as unknown as { encryption: { getSessionEncryption: (id: string) => unknown } }).encryption;
        const getKey = sessionEncryption.getSessionEncryption;
        let keyReady = false;
        sessionEncryption.getSessionEncryption = (id: string) => (keyReady ? getKey(id) : null);
        const s = sync as unknown as { startRoutedCatchUp: (path: string) => void; applySessions: (x: unknown[]) => void; routedSession: string | null };
        try {
            s.startRoutedCatchUp(`/session/${sid}`); // what #init does with location.pathname
            await settle();
            // Before B-819: nothing until SessionDetailScreen mounted and called onSessionEnter.
            expect(afterSeqs).toEqual([2]);
            keyReady = true;
            s.applySessions([storage.getState().sessions[sid]]);
            await settle();
            expect(texts(sid)).toEqual(serverTexts(sid));
            expect(afterSeqs).toEqual([2]);
        } finally {
            sessionEncryption.getSessionEncryption = getKey;
            s.routedSession = null;
        }
    });

    it('B1: a live update buffered after the probe answered, past a hole, is still caught up — prefix only, seqs only go up', async () => {
        const sid = newSession();
        for (let i = 1; i <= 3; i++) store(sid, `m${i}`);
        await visit(sid);
        store(sid, 'm4');
        store(sid, 'm5');
        reload(sid);
        afterSeqs = [];
        const applied = recordApplied(sid);
        const release = gateDecrypt();
        sync.onSessionEnter(sid);
        await settle();
        expect(afterSeqs).toEqual([2]); // answered: m3..m5, hasMore false
        store(sid, 'm6');
        const m7 = store(sid, 'm7');
        await pushLive(sid, m7); // m6's push never came: m7 is buffered past a hole
        expect(texts(sid)).toEqual([]);
        release();
        await settle();
        expect(texts(sid)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']); // never across the hole
        // B-812: m7 waits in the reorder buffer (spec §5.1-4); its expiry asks the catch-up.
        await reorderWindow();
        // Without the follow-up the transcript stopped at m5 (the probe predates m6/m7, the render dropped m7).
        expect(texts(sid)).toEqual(serverTexts(sid));
        expect(applied).toEqual([[1, 2, 3, 4, 5], [6, 7]]);
        expectMonotonic(applied);
        expect(afterSeqs).toEqual([2, 5]);
    });
});

describe('B-819 B1: a probe answering AFTER the render still reaches a buffered update it predates', () => {
    it('render drops m7 past the hole; the probe (asked before m6/m7) brings m4–m5; the catch-up goes on to m7', async () => {
        const sid = newSession();
        for (let i = 1; i <= 3; i++) store(sid, `m${i}`);
        await visit(sid);
        store(sid, 'm4');
        store(sid, 'm5');
        reload(sid);
        afterSeqs = [];
        snapshotAtRequest = true;
        const applied = recordApplied(sid);
        const releaseDecrypt = gateDecrypt();
        const releaseProbe = gate();
        sync.onSessionEnter(sid);
        await settle();
        expect(afterSeqs).toEqual([2]); // the probe's answer is fixed now: m3..m5
        store(sid, 'm6');
        await pushLive(sid, store(sid, 'm7')); // buffered past a hole
        releaseDecrypt();
        await settle();
        expect(texts(sid)).toEqual(['m1', 'm2', 'm3']); // not across the hole
        releaseProbe();
        await settle();
        expect(texts(sid)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
        // B-812: m7 waits in the reorder buffer (spec §5.1-4); its expiry asks the catch-up.
        await reorderWindow();
        // Without the follow-up: stuck at m5 until some later event.
        expect(texts(sid)).toEqual(serverTexts(sid));
        expect(applied).toEqual([[1, 2, 3], [4, 5], [6, 7]]);
        expectMonotonic(applied);
        expect(afterSeqs).toEqual([2, 5]);
    });
});

describe('B-813 review B1: live updates buffered during boot never render across the cache hole', () => {
    it('stale cache m1..m3, server m1..m9, m9 pushed during boot → the transcript is always a server prefix, seqs only go up', async () => {
        const sid = newSession();
        for (let i = 1; i <= 3; i++) store(sid, `m${i}`);
        await visit(sid);
        for (let i = 4; i <= 9; i++) store(sid, `m${i}`);
        reload(sid);
        const applied = recordApplied(sid);
        const release = gate();
        await pushLive(sid, server.get(sid)!.at(-1)!);
        sync.onSessionEnter(sid);
        await settle();
        // Before: ["m1","m2","m3","m9"] — m4..m8 silently missing until the catch-up.
        expect(texts(sid)).toEqual(['m1', 'm2', 'm3']);
        expect(isPrefix(texts(sid), serverTexts(sid))).toBe(true);
        release();
        await settle();
        expect(texts(sid)).toEqual(serverTexts(sid));
        // Before: [[1,2,3,9],[4,5,6,7,8,9]].
        expect(applied).toEqual([[1, 2, 3], [4, 5, 6, 7, 8, 9]]);
        expectMonotonic(applied);
    });

    it('the buffered run that does continue the cache applies with it; the part past a hole waits for the catch-up', async () => {
        const sid = newSession();
        for (let i = 1; i <= 3; i++) store(sid, `m${i}`);
        await visit(sid);
        for (let i = 4; i <= 7; i++) store(sid, `m${i}`);
        reload(sid);
        const applied = recordApplied(sid);
        const release = gate();
        const [m4, m5, , m7] = server.get(sid)!.slice(3);
        for (const message of [m7, m4, m5]) await pushLive(sid, message);
        sync.onSessionEnter(sid);
        await settle();
        expect(texts(sid)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
        release();
        await settle();
        expect(texts(sid)).toEqual(serverTexts(sid));
        expect(applied).toEqual([[1, 2, 3, 4, 5], [6, 7]]);
        expectMonotonic(applied);
    });
});

describe('B-813 review S2: a session anchored while the cache was read keeps its anchor', () => {
    it('the cached run does not overwrite lastSeq or the transcript; the session loads as if there were no cache', async () => {
        const sid = newSession();
        for (let i = 1; i <= 3; i++) store(sid, `m${i}`);
        await visit(sid);
        for (let i = 4; i <= 5; i++) store(sid, `m${i}`);
        reload(sid);
        // B-812: the merge cursor (sessionMerge.ts).
        const cursors = (sync as unknown as { cursors: Map<string, { lastSeq?: number; oldestSeq?: number }> }).cursors;
        const s = {
            sessionLastSeq: { get: (id: string) => cursors.get(id)?.lastSeq, set: (id: string, seq: number) => { (cursors.get(id) ?? cursors.set(id, { generation: 0, pending: new Map(), anchorRequested: false } as never).get(id)!).lastSeq = seq; } },
            sessionOldestSeq: { set: (id: string, seq: number) => { cursors.get(id)!.oldestSeq = seq; } },
        };
        const load = syncCache.load.bind(syncCache);
        // Another path (e.g. a restarted load that got the latest page first) anchors the session at 5 meanwhile.
        vi.spyOn(syncCache, 'load').mockImplementation(async (...args) => {
            const hit = await load(...args);
            s.sessionLastSeq.set(sid, 5);
            s.sessionOldestSeq.set(sid, 1);
            return hit;
        });
        const applied = recordApplied(sid);
        const release = gate();
        sync.onSessionEnter(sid);
        await settle();
        expect(s.sessionLastSeq.get(sid)).toBe(5);
        expect(applied.some((batch) => batch.join() === '1,2,3')).toBe(false);
        expect(isPrefix(texts(sid), serverTexts(sid))).toBe(true);
        release();
        await settle();
        expect(s.sessionLastSeq.get(sid)).toBe(5);
        expect(texts(sid)).toEqual(serverTexts(sid));
        expect(applied.some((batch) => batch.join() === '1,2,3')).toBe(false);
    });
});

describe('B-813 §5.4.2: a wrong cache costs one cold load, never a wrong transcript', () => {
    it('row 5: the server is behind the cache (DB restored) → transcript = server, cache dropped', async () => {
        const sid = newSession();
        for (let i = 1; i <= 4; i++) store(sid, `m${i}`);
        await visit(sid);
        server.set(sid, server.get(sid)!.slice(0, 2));
        reload(sid);
        gets = [];
        sync.onSessionEnter(sid);
        await settle();
        expect(texts(sid)).toEqual(['m1', 'm2']);
        expect(gets).toEqual([`${sid}?after`, `${sid}?before`]);
        expect(syncCache.stats().drops.behind).toBe(1);
    });

    it('row 6: the server row at lastSeq has another id → transcript = server, cache dropped', async () => {
        const sid = newSession();
        for (let i = 1; i <= 3; i++) store(sid, `m${i}`);
        await visit(sid);
        server.set(sid, []);
        for (let i = 1; i <= 3; i++) store(sid, `n${i}`, `recreated-${i}`);
        reload(sid);
        const mismatches = syncCache.stats().drops.mismatch ?? 0;
        sync.onSessionEnter(sid);
        await settle();
        expect(texts(sid)).toEqual(['n1', 'n2', 'n3']);
        expect(syncCache.stats().drops.mismatch).toBe(mismatches + 1);
        await syncCache.flush();
        expect((await syncCache.load(sid))?.lastId).toBe('recreated-3');
    });

    it('row 5 survives a failed check: the retry checks again instead of a plain forward', async () => {
        const sid = newSession();
        for (let i = 1; i <= 4; i++) store(sid, `m${i}`);
        await visit(sid);
        server.set(sid, server.get(sid)!.slice(0, 2));
        reload(sid);
        failAfter = 1;
        afterSeqs = [];
        sync.onSessionEnter(sid);
        await vi.waitFor(() => expect(texts(sid)).toEqual(['m1', 'm2']), { timeout: 5_000 });
        expect(afterSeqs).toEqual([3, 3]);
    });

    it('row 3: a cached row that does not decrypt → cold load, and its failed decryption is forgotten', async () => {
        const sid = newSession();
        for (let i = 1; i <= 3; i++) store(sid, `m${i}`);
        await visit(sid);
        await rawCacheTx((tx) => tx.objectStore('messages').put({ ...server.get(sid)![1], sid, content: { t: 'encrypted', c: 'garbage' } } satisfies StoredRow));
        reload(sid);
        gets = [];
        sync.onSessionEnter(sid);
        await settle();
        expect(texts(sid)).toEqual(['m1', 'm2', 'm3']);
        // B-819: the anchor probe went out alongside the render and is discarded; the transcript is the cold page.
        expect(gets.filter((get) => get.endsWith('before'))).toEqual([`${sid}?before`]);
        expect(syncCache.stats().drops.decrypt).toBe(1);
        expect(forgotten).toContain(`${sid}-m2`);
    });

    it('§9.2-11: an old session with seq holes opens from the cache (holes are history, not corruption)', async () => {
        const sid = newSession();
        store(sid, 'm1');
        store(sid, 'm2', undefined, 2); // seq 4: 2–3 never existed
        store(sid, 'm3');
        await visit(sid);
        store(sid, 'm4', undefined, 3); // seq 9, written while away, across another hole
        reload(sid);
        gets = [];
        const dropsBefore = JSON.stringify(syncCache.stats().drops);
        sync.onSessionEnter(sid);
        await settle();
        expect(texts(sid)).toEqual(['m1', 'm2', 'm3', 'm4']);
        expect(gets).toEqual([`${sid}?after`]);
        expect(JSON.stringify(syncCache.stats().drops)).toBe(dropsBefore);
        await syncCache.flush();
        expect((await syncCache.load(sid))).toMatchObject({ lastSeq: 9, lastRowSeq: 9 });
    });

    it('spec r2: a row the cache wrote and then lost → cold load, the transcript is complete', async () => {
        const sid = newSession();
        for (let i = 1; i <= 3; i++) store(sid, `m${i}`);
        await visit(sid);
        await rawCacheTx((tx) => tx.objectStore('messages').delete([sid, 2]));
        reload(sid);
        gets = [];
        sync.onSessionEnter(sid);
        await settle();
        expect(texts(sid)).toEqual(['m1', 'm2', 'm3']);
        expect(gets).toEqual([`${sid}?before`]);
    });

    it('row 4 (r1): a cached row outside its range → cold load', async () => {
        const sid = newSession();
        for (let i = 1; i <= 3; i++) store(sid, `m${i}`);
        await visit(sid);
        await rawCacheTx((tx) => tx.objectStore('messages').put({ ...server.get(sid)![2], seq: 40, sid } satisfies StoredRow));
        reload(sid);
        gets = [];
        sync.onSessionEnter(sid);
        await settle();
        expect(texts(sid)).toEqual(['m1', 'm2', 'm3']);
        expect(gets).toEqual([`${sid}?before`]);
        expect(syncCache.stats().drops.range).toBe(1);
    });

    it('row 7: a deleted session leaves nothing in the cache', async () => {
        const sid = newSession();
        store(sid, 'm1');
        await visit(sid);
        sync.onSessionDeleted(sid);
        await syncCache.flush();
        expect(await syncCache.load(sid)).toBeNull();
    });

    it('QuotaExceeded on every write → the network path, same transcript, every time', async () => {
        const quota = () => new DOMException('quota', 'QuotaExceededError');
        vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw quota(); });
        const sid = newSession();
        for (let i = 1; i <= 3; i++) store(sid, `m${i}`);
        await visit(sid);
        expect(texts(sid)).toEqual(['m1', 'm2', 'm3']);
        expect(syncCache.stats().readOnly).toBe(true);
        store(sid, 'm4');
        reload(sid);
        gets = [];
        sync.onSessionEnter(sid);
        await settle();
        expect(texts(sid)).toEqual(['m1', 'm2', 'm3', 'm4']);
        expect(gets).toEqual([`${sid}?before`]);
    });

    it('row 8: a stuck cache read → the network path after at most 2s, cache off for the page', async () => {
        const sid = newSession();
        for (let i = 1; i <= 2; i++) store(sid, `m${i}`);
        await visit(sid);
        reload(sid);
        vi.spyOn(IDBObjectStore.prototype, 'openCursor').mockImplementation(() => ({}) as IDBRequest);
        gets = [];
        const t0 = Date.now();
        sync.onSessionEnter(sid);
        await vi.waitFor(() => expect(texts(sid)).toEqual(['m1', 'm2']), { timeout: 5_000 });
        expect(Date.now() - t0).toBeLessThan(3_000);
        expect(gets).toEqual([`${sid}?before`]);
        expect(syncCache.stats().state).toBe('disabled');
    });
});

// B-812 × B-813: in subscribe mode the cache still renders first; the subscribe
// that follows asks from the cached newest row - 1, so its ack checks that row
// (§5.4.2) the way the REST probe does on the legacy path.
describe('B-812 subscribe mode with the cache', () => {
    type Emit = { event: string; payload: any };
    let emits: Emit[];
    let holdAcks: Array<() => void> | null;

    function snapshot(sub: { sid: string; afterSeq: number | null; limit?: number }) {
        const all = server.get(sub.sid) ?? [];
        const head = all.at(-1)?.seq ?? 0;
        if (sub.afterSeq === null) return { sid: sub.sid, ok: true, headSeq: head, messages: all.slice(-(sub.limit ?? 200)), hasMore: false, ...(all.length ? { oldestSeq: all.slice(-(sub.limit ?? 200))[0].seq } : {}) };
        return { sid: sub.sid, ok: true, headSeq: head, messages: all.filter((m) => m.seq > sub.afterSeq!), hasMore: false };
    }

    beforeEach(async () => {
        emits = [];
        holdAcks = null;
        vi.spyOn(apiSocket, 'isControlConnected').mockReturnValue(true);
        vi.spyOn(apiSocket, 'emitWithTimeout').mockImplementation((event, payload) => new Promise((resolve) => {
            emits.push({ event, payload });
            const p = payload as any;
            const answer = () => resolve((event === 'sync-hello'
                ? { ok: true, v: 1, serverTime: 0, limits: { maxSubs: 16, maxLimit: 500, gapThreshold: 500 }, results: p.subs.map(snapshot) }
                : event === 'session-subscribe' ? snapshot(p) : { ok: true }) as never);
            if (holdAcks && event === 'session-subscribe') holdAcks.push(answer);
            else answer();
        }));
        const done = sync.syncScheduler.connect('connect');
        await settle();
        await done;
    });

    afterEach(() => {
        sync.syncScheduler.disconnected();
    });

    const subscribes = (sid: string) => emits.filter((e) => e.event === 'session-subscribe' && e.payload.sid === sid);
    const phase = (sid: string) => sync.syncScheduler.phase(sid)?.phase ?? null;

    it('reload: the cached run renders before the ack, the subscribe asks from its newest row - 1, then live — 0 REST', async () => {
        const sid = newSession();
        for (let i = 1; i <= 3; i++) store(sid, `m${i}`);
        sync.onSessionEnter(sid);
        await settle();
        await syncCache.flush();
        expect(subscribes(sid).map((e) => e.payload.afterSeq)).toEqual([null]);
        expect(texts(sid)).toEqual(['m1', 'm2', 'm3']);
        for (let i = 4; i <= 5; i++) store(sid, `m${i}`);
        reload(sid);
        sync.syncScheduler.forget(sid);
        emits = [];
        gets = [];
        holdAcks = [];
        sync.onSessionEnter(sid);
        await settle();
        expect(texts(sid)).toEqual(['m1', 'm2', 'm3']); // the cache, before any answer
        expect(subscribes(sid).map((e) => e.payload.afterSeq)).toEqual([2]);
        expect(phase(sid)).toBe('syncing');
        for (const answer of holdAcks) answer();
        holdAcks = null;
        await settle();
        expect(texts(sid)).toEqual(serverTexts(sid));
        expect(phase(sid)).toBe('live');
        expect(gets).toEqual([]);
    });

    it('a forward ack writes its rows back to the cache: the next reload renders them and asks from the new newest row - 1 (G1-20)', async () => {
        const sid = newSession();
        for (let i = 1; i <= 3; i++) store(sid, `m${i}`);
        sync.onSessionEnter(sid);
        await settle();
        await syncCache.flush();
        for (let i = 4; i <= 5; i++) store(sid, `m${i}`);
        reload(sid);
        sync.syncScheduler.forget(sid);
        emits = [];
        sync.onSessionEnter(sid);
        await settle();
        await syncCache.flush();
        expect(subscribes(sid).map((e) => e.payload.afterSeq)).toEqual([2]); // the forward snapshot, not a cold page
        expect(texts(sid)).toEqual(serverTexts(sid));
        reload(sid);
        sync.syncScheduler.forget(sid);
        emits = [];
        gets = [];
        holdAcks = [];
        sync.onSessionEnter(sid);
        await settle();
        expect(texts(sid)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']); // from the cache, before any answer
        expect(subscribes(sid).map((e) => e.payload.afterSeq)).toEqual([4]);
        for (const answer of holdAcks) answer();
        holdAcks = null;
        await settle();
        expect(phase(sid)).toBe('live');
        expect(gets).toEqual([]);
    });

    it('a cold open while the hello is still out (page load) renders the cache at once, then subscribes from it', async () => {
        const sid = newSession();
        for (let i = 1; i <= 3; i++) store(sid, `m${i}`);
        sync.onSessionEnter(sid);
        await settle();
        await syncCache.flush();
        store(sid, 'm4');
        reload(sid);
        sync.syncScheduler.forget(sid);
        // A new connection whose hello is not answered yet.
        let answerHello!: () => void;
        const original = (apiSocket.emitWithTimeout as any).getMockImplementation();
        (apiSocket.emitWithTimeout as any).mockImplementation((event: string, payload: unknown, ms: number) => {
            if (event !== 'sync-hello') return original(event, payload, ms);
            return new Promise((resolve) => { answerHello = () => resolve(original(event, payload, ms)); });
        });
        const connecting = sync.syncScheduler.connect('connect');
        await settle();
        emits = [];
        gets = [];
        sync.onSessionEnter(sid);
        await settle();
        expect(sync.syncScheduler.getMode()).toBe('negotiating');
        expect(texts(sid)).toEqual(['m1', 'm2', 'm3']); // the cache, no network yet
        expect(gets).toEqual([]);
        answerHello();
        await connecting;
        await settle();
        expect(subscribes(sid).map((e) => e.payload.afterSeq)).toEqual([2]);
        expect(texts(sid)).toEqual(serverTexts(sid));
        expect(phase(sid)).toBe('live');
        expect(gets).toEqual([]);
    });

    it('§5.4.2 row 6 over the socket: the server row at the cached seq has another id → cache dropped, one cold subscribe, transcript = server', async () => {
        const sid = newSession();
        for (let i = 1; i <= 3; i++) store(sid, `m${i}`);
        sync.onSessionEnter(sid);
        await settle();
        await syncCache.flush();
        // The history was rewritten behind the cache: seq 3 is another message now.
        server.set(sid, server.get(sid)!.slice(0, 2));
        store(sid, 'm3-other', 'other-id');
        store(sid, 'm4');
        reload(sid);
        sync.syncScheduler.forget(sid);
        emits = [];
        sync.onSessionEnter(sid);
        await settle();
        await settle();
        expect(subscribes(sid).map((e) => e.payload.afterSeq)).toEqual([2, null]);
        expect(texts(sid)).toEqual(['m1', 'm2', 'm3-other', 'm4']);
        expect(phase(sid)).toBe('live');
    });
});
