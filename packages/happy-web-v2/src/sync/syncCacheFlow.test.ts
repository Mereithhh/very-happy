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
    const encryption = {
        decryptMessage: async (message: ServerMessage) => decrypt(message),
        decryptMessages: async (messages: ServerMessage[]) => messages.map(decrypt),
        forgetMessages: (ids: string[]) => { forgotten.push(...ids); },
    };
    (sync as unknown as { encryption: unknown }).encryption = { getSessionEncryption: (id: string) => (server.has(id) ? encryption : null), removeSessionEncryption: () => {} };
    vi.spyOn(apiSocket, 'request').mockImplementation(async (path) => {
        const url = new URL(String(path), 'http://x');
        const sid = url.pathname.split('/')[3];
        const all = server.get(sid) ?? [];
        const after = url.searchParams.get('after_seq');
        gets.push(`${sid}?${after !== null ? 'after' : 'before'}`);
        if (after !== null) {
            afterSeqs.push(Number(after));
            if (afterGate) await afterGate;
            if (failAfter > 0) {
                failAfter -= 1;
                throw new DOMException('read deadline', 'TimeoutError');
            }
        }
        const messages = after !== null ? all.filter((m) => m.seq > Number(after)) : [...all].reverse();
        return new Response(JSON.stringify({ messages, hasMore: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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

const texts = (sid: string) => (storage.getState().sessionMessages[sid]?.messages ?? [])
    .filter((m) => m.kind === 'user-text')
    .map((m) => (m as { text: string }).text)
    .reverse();
const serverTexts = (sid: string) => server.get(sid)!.map((m) => JSON.parse(m.content.c).content.text as string);

/** A page reload, as far as this session is concerned: memory forgets it, IndexedDB keeps it. */
function reload(sid: string) {
    const s = sync as unknown as Record<string, { delete?: (k: string) => void; clear?: (k: string) => void }>;
    s.sessionLastSeq.delete!(sid);
    s.sessionOldestSeq.delete!(sid);
    s.messagesSync.delete!(sid);
    s.unverifiedCacheHits.delete!(sid);
    s.anchorBuffer.clear!(sid);
    storage.getState().resetSessionMessages(sid);
}

/** First visit: the latest page loads from the network and lands in the cache. */
async function visit(sid: string) {
    sync.onSessionEnter(sid);
    await settle();
    await syncCache.flush();
}

function gate() {
    let release!: () => void;
    afterGate = new Promise<void>((resolve) => { release = resolve; });
    return () => { afterGate = null; release(); };
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
        release();
        await settle();
        expect(texts(sid)).toEqual(serverTexts(sid));
        expect(gets).toEqual([`${sid}?after`]);
        expect(afterSeqs).toEqual([2]);

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
        sync.onSessionEnter(sid);
        await settle();
        expect(texts(sid)).toEqual(['n1', 'n2', 'n3']);
        expect(syncCache.stats().drops.mismatch).toBe(1);
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
        expect(gets).toEqual([`${sid}?before`]);
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
