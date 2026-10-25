/**
 * B-813 (spec B-807 §5.4 / §5.4.1 / §5.4.2): the IndexedDB message cache on
 * fake-indexeddb — round trip, ciphertext only, the contiguous run, the LRU
 * limits, QuotaExceeded, and every corruption row of §5.4.2 (the cache-level
 * half; the transcript-level half is syncCacheFlow.test.ts).
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiMessage } from '@/sync/apiTypes';
import { CACHE_DB_PREFIX, CACHE_SCHEMA, CACHE_SWITCH_KEY, SyncCache, clearSyncCaches, type StoredRow } from './syncCache';
import { CACHE_MAX_SESSIONS } from './lru';

const ACCOUNT = 'account-1';

function row(seq: number, sid = 's', id = `${sid}-m${seq}`): ApiMessage {
    return { id, seq, localId: null, content: { t: 'encrypted', c: `Y2lwaGVy${seq}` }, createdAt: seq, updatedAt: seq };
}
const rows = (from: number, to: number, sid = 's') => Array.from({ length: to - from + 1 }, (_, i) => row(from + i, sid));

function memoryStorage() {
    const map = new Map<string, string>();
    return {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => void map.set(key, value),
        removeItem: (key: string) => void map.delete(key),
    };
}

type Harness = { cache: SyncCache; factory: IDBFactory; storage: ReturnType<typeof memoryStorage>; now: { t: number } };

function harness(factory = new IDBFactory(), storage = memoryStorage()): Harness {
    const now = { t: 1_000 };
    const cache = new SyncCache({ factory: () => factory, now: () => now.t, localStorage: () => storage, idle: () => {} });
    return { cache, factory, storage, now };
}

async function opened(h = harness()) {
    await h.cache.open(ACCOUNT);
    return h;
}

/** Raw access to the cache database, as another tab or a corrupted disk would see it. */
async function rawDb(factory: IDBFactory): Promise<IDBDatabase> {
    const listed = await factory.databases();
    const name = listed.find((db) => db.name?.startsWith(CACHE_DB_PREFIX))!.name!;
    return new Promise((resolve, reject) => {
        const request = factory.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function rawTx<T>(factory: IDBFactory, stores: string[], fn: (tx: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
    const db = await rawDb(factory);
    try {
        return await new Promise<T | undefined>((resolve, reject) => {
            const tx = db.transaction(stores, 'readwrite');
            const request = fn(tx);
            let result: T | undefined;
            if (request) request.onsuccess = () => { result = request.result; };
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(tx.error);
        });
    } finally {
        db.close();
    }
}

const allRows = (factory: IDBFactory) => rawTx<StoredRow[]>(factory, ['messages'], (tx) => tx.objectStore('messages').getAll());

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('B-813 cache round trip (§5.4)', () => {
    it('a latest page is read back as the same server rows, and only their ciphertext is stored', async () => {
        const { cache, factory } = await opened();
        cache.offerLatest('s', rows(1, 5), { viewed: true });
        await cache.flush();
        const hit = await cache.load('s');
        expect(hit).toMatchObject({ oldestSeq: 1, lastSeq: 5, lastId: 's-m5' });
        expect(hit!.rows).toEqual(rows(1, 5));

        const stored = await allRows(factory);
        expect(stored).toHaveLength(5);
        for (const r of stored!) {
            expect(Object.keys(r).sort()).toEqual(['content', 'createdAt', 'id', 'localId', 'seq', 'sid', 'updatedAt']);
            expect(Object.keys(r.content).sort()).toEqual(['c', 't']);
            expect(r.content.t).toBe('encrypted');
        }
    });

    it('refuses anything that is not a ciphertext row', async () => {
        const { cache, factory } = await opened();
        const plain = { ...row(2), content: { t: 'plain', text: 'secret' } } as unknown as ApiMessage;
        cache.offerLatest('s', [row(1), plain], { viewed: true });
        await cache.flush();
        expect((await allRows(factory))!.map((r) => r.seq)).toEqual([1]);
        expect(JSON.stringify(await allRows(factory))).not.toContain('secret');
    });

    it('a session without a cached run is a miss without touching IndexedDB', async () => {
        const { cache } = await opened();
        cache.offerLatest('s', rows(1, 2));
        await cache.flush();
        const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction');
        expect(cache.mayHave('other')).toBe(false);
        expect(await cache.load('other')).toBeNull();
        expect(transaction).not.toHaveBeenCalled();
        expect(cache.mayHave('s')).toBe(true);
    });

    it('the database is per account: another account sees nothing', async () => {
        const factory = new IDBFactory();
        const a = await opened(harness(factory));
        a.cache.offerLatest('s', rows(1, 3), { viewed: true });
        await a.cache.flush();
        a.cache.close();
        const b = harness(factory);
        await b.cache.open('account-2');
        expect(await b.cache.load('s')).toBeNull();
        expect((await factory.databases()).filter((db) => db.name?.startsWith(CACHE_DB_PREFIX))).toHaveLength(2);
    });
});

describe('B-813 the contiguous run', () => {
    it('newer rows extend it; rows above a hole wait until the hole fills', async () => {
        const { cache } = await opened();
        cache.offerLatest('s', rows(1, 3));
        cache.offerNewer('s', [row(5), row(6)]);
        await cache.flush();
        expect((await cache.load('s'))!.lastSeq).toBe(3);
        cache.offerNewer('s', [row(4)]);
        await cache.flush();
        const hit = await cache.load('s');
        expect(hit!.lastSeq).toBe(6);
        expect(hit!.rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('r1: a latest page with a seq hole is kept whole — the hole is history, not a gap', async () => {
        const { cache } = await opened();
        cache.offerLatest('s', [row(1), row(2), row(4), row(5)]);
        await cache.flush();
        expect((await cache.load('s'))!.rows.map((r) => r.seq)).toEqual([1, 2, 4, 5]);
    });

    it('r1: a forward page (range result) extends the run across a seq hole; a push across it waits', async () => {
        const { cache } = await opened();
        cache.offerLatest('s', rows(1, 3));
        cache.offerNewer('s', [row(6)]); // push: 4–5 unknown
        await cache.flush();
        expect((await cache.load('s'))!.lastSeq).toBe(3);
        cache.offerNewer('s', [row(5), row(6)], { afterSeq: 3 }); // the server has no 4
        await cache.flush();
        const hit = await cache.load('s');
        expect(hit!.rows.map((r) => r.seq)).toEqual([1, 2, 3, 5, 6]);
        expect([hit!.lastSeq, hit!.lastRowSeq]).toEqual([6, 6]);
        cache.offerNewer('s', [row(9)], { afterSeq: 7 }); // does not reach the run (7 > 6)
        await cache.flush();
        expect((await cache.load('s'))!.lastSeq).toBe(6);
    });

    it('pushes that arrive before the first latest page join the run when it lands', async () => {
        const { cache } = await opened();
        cache.offerNewer('s', [row(4)]);
        await cache.flush();
        expect(await cache.load('s')).toBeNull();
        cache.offerLatest('s', rows(1, 3));
        await cache.flush();
        expect((await cache.load('s'))!.lastSeq).toBe(4);
    });

    it('r1: trimming keeps the newest 300 ROWS, also across seq holes', async () => {
        const { cache, factory } = await opened();
        const holey = rows(1, 400).filter((r) => r.seq % 4 !== 0); // 300 rows in 1–400
        cache.offerLatest('s', holey.slice(-200));
        await cache.flush();
        cache.offerOlder('s', holey.slice(0, -200), { beforeSeq: holey.at(-200)!.seq });
        cache.offerNewer('s', [row(401), row(402)], { afterSeq: 399 }); // 400 is a hole: the run ends at 399
        await cache.flush();
        const hit = await cache.load('s');
        expect(hit!.rows).toHaveLength(300);
        expect(hit!.rows.at(-1)!.seq).toBe(402);
        expect(hit!.oldestSeq).toBe(holey[2].seq); // the two oldest rows went
        expect((await allRows(factory))!.length).toBe(300);
    });

    it('keeps the newest 300 rows per session (Owner 10-25) and older pages only fill up to 300', async () => {
        const { cache, factory } = await opened();
        cache.offerLatest('s', rows(201, 400));
        cache.offerOlder('s', rows(1, 200), { beforeSeq: 201 });
        await cache.flush();
        let hit = await cache.load('s');
        expect(hit!.oldestSeq).toBe(101);
        expect(hit!.rows).toHaveLength(300);
        cache.offerNewer('s', rows(401, 450), { afterSeq: 400 });
        await cache.flush();
        hit = await cache.load('s');
        expect([hit!.oldestSeq, hit!.lastSeq, hit!.rows.length]).toEqual([151, 450, 300]);
        expect((await allRows(factory))!.length).toBe(300);
    });

    it('a new latest page replaces the old run', async () => {
        const { cache, factory } = await opened();
        cache.offerLatest('s', rows(1, 10));
        await cache.flush();
        cache.offerLatest('s', rows(50, 60));
        await cache.flush();
        expect((await allRows(factory))!.map((r) => r.seq)).toEqual(rows(50, 60).map((r) => r.seq));
    });
});

describe('B-813 LRU (§5.4.1: 30 sessions, 40MB; outbox sessions stay)', () => {
    it('drops the least recently viewed sessions past 30, never one with an outbox row', async () => {
        const h = await opened();
        for (let i = 0; i < CACHE_MAX_SESSIONS + 3; i++) {
            h.now.t = 10_000 + i;
            h.cache.offerLatest(`s${i}`, rows(1, 2, `s${i}`), { viewed: true });
            await h.cache.flush();
        }
        await rawTx(h.factory, ['outbox'], (tx) => tx.objectStore('outbox').put({ localId: 'l1', sid: 's0', ownerTabId: 't' }));
        await h.cache.cleanupNow();
        expect(await h.cache.load('s0')).not.toBeNull(); // protected by its outbox row
        expect(await h.cache.load('s1')).toBeNull();
        expect(await h.cache.load('s2')).toBeNull();
        expect(await h.cache.load('s3')).toBeNull();
        expect(await h.cache.load('s4')).not.toBeNull();
        expect(h.cache.stats().evicted).toBe(3);
    });

    it('a session loaded only for board previews (not viewed) goes first', async () => {
        const h = await opened();
        for (let i = 0; i < CACHE_MAX_SESSIONS; i++) {
            h.now.t = 10_000 + i;
            h.cache.offerLatest(`v${i}`, rows(1, 1, `v${i}`), { viewed: true });
        }
        h.cache.offerLatest('preview', rows(1, 1, 'preview'));
        await h.cache.flush();
        await h.cache.cleanupNow();
        expect(await h.cache.load('preview')).toBeNull();
        expect(await h.cache.load('v0')).not.toBeNull();
    });
});

describe('B-813 QuotaExceededError (§5.4.1)', () => {
    const quota = () => new DOMException('quota', 'QuotaExceededError');

    it('drops the older half and retries once', async () => {
        const h = await opened();
        for (let i = 0; i < 4; i++) {
            h.now.t = 10_000 + i;
            h.cache.offerLatest(`s${i}`, rows(1, 2, `s${i}`), { viewed: true });
        }
        await h.cache.flush();
        const put = IDBObjectStore.prototype.put;
        let failures = 1;
        vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
            if (this.name === 'messages' && failures-- > 0) throw quota();
            return put.apply(this, args);
        });
        h.cache.offerLatest('new', rows(1, 2, 'new'), { viewed: true });
        await h.cache.flush();
        expect(h.cache.stats()).toMatchObject({ quotaErrors: 1, evicted: 2, readOnly: false });
        expect(await h.cache.load('new')).not.toBeNull();
        expect(await h.cache.load('s0')).toBeNull();
        expect(await h.cache.load('s3')).not.toBeNull();
    });

    it('still full after the retry → writes stop for this page, reads keep working', async () => {
        const h = await opened();
        h.cache.offerLatest('old', rows(1, 3, 'old'), { viewed: true });
        h.now.t += 1;
        h.cache.offerLatest('s', rows(1, 3), { viewed: true });
        await h.cache.flush();
        vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function () { throw quota(); });
        h.cache.offerNewer('s', [row(4)]);
        await h.cache.flush();
        vi.restoreAllMocks();
        expect(h.cache.stats()).toMatchObject({ quotaErrors: 2, readOnly: true, evicted: 1 });
        h.cache.offerNewer('s', [row(4)]);
        await h.cache.flush();
        expect((await h.cache.load('s'))!.lastSeq).toBe(3);
    });
});

describe('B-813 §5.4.2 corruption and inconsistency — every row ends in "no cache", never in a wrong transcript', () => {
    it('row 1: indexedDB.open throws → this tab runs without a cache', async () => {
        const factory = new IDBFactory();
        vi.spyOn(factory, 'open').mockImplementation(() => { throw new DOMException('private mode', 'InvalidStateError'); });
        const h = harness(factory);
        await h.cache.open(ACCOUNT);
        expect(h.cache.stats()).toMatchObject({ state: 'disabled' });
        h.cache.offerLatest('s', rows(1, 2));
        expect(await h.cache.load('s')).toBeNull();
    });

    it('row 1: open stays blocked > 3s → this tab runs without a cache', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const request = {} as IDBOpenDBRequest & { onblocked: (() => void) | null };
        let opens = 0;
        const factory = { open: () => { opens += 1; queueMicrotask(() => request.onblocked?.()); return request; } } as unknown as IDBFactory;
        const h = harness(factory);
        const opening = h.cache.open(ACCOUNT);
        while (opens === 0) await new Promise((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(2_900);
        expect(h.cache.stats().state).toBe('opening');
        await vi.advanceTimersByTimeAsync(200);
        await opening;
        expect(h.cache.stats()).toMatchObject({ state: 'disabled', disabledReason: expect.stringContaining('blocked') });
    });

    it('row 2: meta.schema differs → the database is deleted and rebuilt empty', async () => {
        const factory = new IDBFactory();
        const first = await opened(harness(factory));
        first.cache.offerLatest('s', rows(1, 3));
        await first.cache.flush();
        first.cache.close();
        await rawTx(factory, ['meta'], (tx) => tx.objectStore('meta').put({ schema: CACHE_SCHEMA + 1, accountHash: 'x', createdAt: 0, lastCleanupAt: 0, appBuild: 'old' }, 'meta'));
        const second = await opened(harness(factory));
        expect(second.cache.stats()).toMatchObject({ state: 'ready', rebuilt: 1 });
        expect(await second.cache.load('s')).toBeNull();
        second.cache.offerLatest('s', rows(1, 2));
        await second.cache.flush();
        expect((await second.cache.load('s'))!.lastSeq).toBe(2);
    });

    it('row 2: a database from a newer build (VersionError) or with missing stores is rebuilt', async () => {
        const factory = new IDBFactory();
        const h = harness(factory);
        await h.cache.open(ACCOUNT); // learn the name
        h.cache.close();
        const name = (await factory.databases())[0].name!;
        await new Promise<void>((resolve) => { const r = factory.deleteDatabase(name); r.onsuccess = () => resolve(); });
        await new Promise<void>((resolve) => {
            const r = factory.open(name, 7);
            r.onupgradeneeded = () => r.result.createObjectStore('unrelated');
            r.onsuccess = () => { r.result.close(); resolve(); };
        });
        const reopened = await opened(harness(factory));
        expect(reopened.cache.stats()).toMatchObject({ state: 'ready', rebuilt: 1 });
        reopened.cache.offerLatest('s', rows(1, 1));
        await reopened.cache.flush();
        expect(await reopened.cache.load('s')).not.toBeNull();
    });

    it('row 2: the rebuild itself fails → no cache', async () => {
        const factory = new IDBFactory();
        await opened(harness(factory)).then((h) => h.cache.close());
        await rawTx(factory, ['meta'], (tx) => tx.objectStore('meta').delete('meta'));
        vi.spyOn(factory, 'deleteDatabase').mockImplementation(() => { throw new DOMException('nope', 'UnknownError'); });
        const h = await opened(harness(factory));
        expect(h.cache.stats().state).toBe('disabled');
        expect(await h.cache.load('s')).toBeNull();
    });

    it('row 3: a row that fails the SyncMessage schema → that session is dropped, others stay', async () => {
        const h = await opened();
        h.cache.offerLatest('s', rows(1, 3));
        h.cache.offerLatest('t', rows(1, 3, 't'));
        await h.cache.flush();
        await rawTx(h.factory, ['messages'], (tx) => tx.objectStore('messages').put({ ...row(2), sid: 's', content: { t: 'encrypted', c: 42 } }));
        expect(await h.cache.load('s')).toBeNull();
        expect(h.cache.stats().drops.schema).toBe(1);
        await h.cache.flush();
        expect((await allRows(h.factory))!.filter((r) => r.sid === 's')).toEqual([]);
        expect((await h.cache.load('t'))!.lastSeq).toBe(3);
    });

    it('row 3 (decrypt): dropSession("decrypt") removes the run', async () => {
        const h = await opened();
        h.cache.offerLatest('s', rows(1, 3));
        await h.cache.flush();
        h.cache.dropSession('s', 'decrypt');
        expect(await h.cache.load('s')).toBeNull(); // even before the delete is flushed
        await h.cache.flush();
        expect(await allRows(h.factory)).toEqual([]);
    });

    it('§9.2-11: a run with seq holes (12 seqs, 9 rows) is a normal hit, not corruption', async () => {
        const h = await opened();
        const holey = rows(1, 12).filter((r) => ![3, 7, 11].includes(r.seq));
        h.cache.offerLatest('s', holey);
        await h.cache.flush();
        await rawTx(h.factory, ['sessions'], (tx) => tx.objectStore('sessions').put({ sid: 's', oldestSeq: 1, lastSeq: 12, headSeqSeen: 12, count: 9, bytes: 1, lastAccessAt: 1, cachedAt: 1 }));
        const hit = await h.cache.load('s');
        expect(hit!.rows).toHaveLength(9);
        expect([hit!.oldestSeq, hit!.lastSeq, hit!.lastRowSeq]).toEqual([1, 12, 12]);
        expect(h.cache.stats().drops).toEqual({});
    });

    it('spec r2: a row the cache wrote and lost locally → that session is dropped (after_seq would never bring it back)', async () => {
        const h = await opened();
        const holey = rows(1, 12).filter((r) => ![3, 7, 11].includes(r.seq));
        h.cache.offerLatest('s', holey);
        await h.cache.flush();
        expect((await h.cache.load('s'))!.rows).toHaveLength(9);
        await rawTx(h.factory, ['messages'], (tx) => tx.objectStore('messages').delete(['s', 5]));
        expect(await h.cache.load('s')).toBeNull();
        expect(h.cache.stats().drops.count).toBe(1);
    });

    it('spec r2: the written-row count stays exact through appends, older pages and trimming', async () => {
        const h = await opened();
        const holey = rows(1, 400).filter((r) => r.seq % 4 !== 0);
        h.cache.offerLatest('s', holey.slice(-100));
        await h.cache.flush();
        h.cache.offerOlder('s', holey.slice(-250, -100), { beforeSeq: holey.at(-100)!.seq });
        h.cache.offerNewer('s', [row(401), row(402), row(403)], { afterSeq: 399 });
        h.cache.offerNewer('s', [row(404)]);
        await h.cache.flush();
        h.cache.offerOlder('s', holey.slice(0, -250), { beforeSeq: holey.at(-250)!.seq });
        await h.cache.flush();
        const hit = await h.cache.load('s');
        expect(hit!.rows).toHaveLength(300);
        const record = await rawTx<{ count: number }>(h.factory, ['sessions'], (tx) => tx.objectStore('sessions').get('s'));
        expect(record!.count).toBe((await allRows(h.factory))!.length);
        expect(h.cache.stats().drops).toEqual({});
    });

    it('row 4 (r1): a row outside [oldestSeq, lastSeq] → that session is dropped', async () => {
        const h = await opened();
        h.cache.offerLatest('s', rows(5, 8));
        await h.cache.flush();
        await rawTx(h.factory, ['messages'], (tx) => tx.objectStore('messages').put({ ...row(2), sid: 's' }));
        expect(await h.cache.load('s')).toBeNull();
        expect(h.cache.stats().drops.range).toBe(1);
    });

    it('row 4: a session record whose range is impossible → dropped', async () => {
        const h = await opened();
        h.cache.offerLatest('s', rows(1, 5));
        await h.cache.flush();
        await rawTx(h.factory, ['sessions'], (tx) => tx.objectStore('sessions').put({ sid: 's', oldestSeq: 9, lastSeq: 5, headSeqSeen: 5, count: 5, bytes: 1, lastAccessAt: 1, cachedAt: 1 }));
        expect(await h.cache.load('s')).toBeNull();
        expect(h.cache.stats().drops.range).toBe(1);
    });

    it('rows 5–6 (server behind / other id): dropSession removes the run', async () => {
        const h = await opened();
        h.cache.offerLatest('s', rows(1, 3));
        await h.cache.flush();
        h.cache.dropSession('s', 'behind');
        await h.cache.flush();
        expect(await h.cache.load('s')).toBeNull();
        h.cache.offerLatest('s', rows(1, 2));
        await h.cache.flush();
        h.cache.dropSession('s', 'mismatch');
        await h.cache.flush();
        expect(await allRows(h.factory)).toEqual([]);
        expect(h.cache.stats().drops).toMatchObject({ behind: 1, mismatch: 1 });
    });

    it('row 7: a deleted session loses its rows, its record and its outbox rows', async () => {
        const h = await opened();
        h.cache.offerLatest('s', rows(1, 3));
        h.cache.offerLatest('t', rows(1, 3, 't'));
        await h.cache.flush();
        await rawTx(h.factory, ['outbox'], (tx) => { tx.objectStore('outbox').put({ localId: 'a', sid: 's', ownerTabId: 'x' }); tx.objectStore('outbox').put({ localId: 'b', sid: 't', ownerTabId: 'x' }); });
        h.cache.dropSession('s', 'deleted');
        await h.cache.flush();
        expect(await h.cache.load('s')).toBeNull();
        expect((await allRows(h.factory))!.every((r) => r.sid === 't')).toBe(true);
        const outbox = await rawTx<Array<{ localId: string }>>(h.factory, ['outbox'], (tx) => tx.objectStore('outbox').getAll());
        expect(outbox!.map((r) => r.localId)).toEqual(['b']);
    });

    it('row 8: a read that takes > 2s → the cache is off for this page', async () => {
        const h = await opened();
        h.cache.offerLatest('s', rows(1, 3));
        await h.cache.flush();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        vi.spyOn(IDBObjectStore.prototype, 'openCursor').mockImplementation(() => ({}) as IDBRequest); // never settles
        const loading = h.cache.load('s');
        await vi.advanceTimersByTimeAsync(2_100);
        expect(await loading).toBeNull();
        expect(h.cache.stats()).toMatchObject({ state: 'disabled', disabledReason: 'stuck read' });
        vi.restoreAllMocks();
        expect(await h.cache.load('s')).toBeNull();
    });

    it('row 8: the QuotaExceeded retry gets stuck > 2s → the cache is off for this page', async () => {
        const h = await opened();
        const put = IDBObjectStore.prototype.put;
        let quotaThrown = false;
        vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
            if (!quotaThrown) { quotaThrown = true; throw new DOMException('quota', 'QuotaExceededError'); }
            return put.apply(this, args);
        });
        const get = IDBObjectStore.prototype.get;
        vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['get']>) {
            return quotaThrown ? ({}) as IDBRequest : get.apply(this, args);
        });
        h.cache.offerLatest('s', rows(1, 3));
        await h.cache.flush(); // real time: the eviction before the retry hangs for its 2s deadline
        expect(h.cache.stats()).toMatchObject({ state: 'disabled', disabledReason: 'stuck write', quotaErrors: 1 });
    }, 10_000);

    it('row 8: a write that takes > 2s → the cache is off for this page', async () => {
        const h = await opened();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(() => ({}) as IDBRequest);
        h.cache.offerLatest('s', rows(1, 3));
        const flushing = h.cache.flush();
        await vi.advanceTimersByTimeAsync(2_100);
        await flushing;
        expect(h.cache.stats()).toMatchObject({ state: 'disabled', disabledReason: 'stuck write' });
    });
});

describe('B-813 switches and logout', () => {
    it('vh.sync.cache=off: no reads, no writes, and the databases are deleted', async () => {
        const factory = new IDBFactory();
        const storage = memoryStorage();
        const first = await opened(harness(factory, storage));
        first.cache.offerLatest('s', rows(1, 2));
        await first.cache.flush();
        first.cache.close();
        storage.setItem(CACHE_SWITCH_KEY, 'off');
        const off = await opened(harness(factory, storage));
        expect(off.cache.stats().state).toBe('off');
        expect(await off.cache.load('s')).toBeNull();
        await vi.waitFor(async () => expect((await factory.databases()).length).toBe(0));
    });

    it('clearSyncCaches deletes every vh-sync-* database, also ones only the registry knows', async () => {
        const factory = new IDBFactory();
        const storage = memoryStorage();
        const h = await opened(harness(factory, storage));
        h.cache.close();
        vi.spyOn(factory, 'databases').mockRejectedValue(new Error('Safari 13'));
        const deleted = await clearSyncCaches(factory, storage);
        expect(deleted).toHaveLength(1);
        vi.restoreAllMocks();
        expect(await factory.databases()).toEqual([]);
    });
});
