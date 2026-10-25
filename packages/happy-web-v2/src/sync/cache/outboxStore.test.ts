/**
 * B-814 (spec B-807 §5.5): the persistent outbox store on fake-indexeddb, in
 * the same per-account database as the message cache — write-through, the
 * 10-minute takeover rule, and "exactly one tab takes each orphan".
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { SyncCache } from './syncCache';
import { OUTBOX_AUTO_RESEND_MS, OUTBOX_TIMEOUT_LIMIT, OutboxStore, takeoverAction, type OutboxRow } from './outboxStore';

function memoryStorage() {
    const map = new Map<string, string>();
    return {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => void map.set(key, value),
        removeItem: (key: string) => void map.delete(key),
    };
}

async function harness(factory = new IDBFactory(), account = 'account-1') {
    const now = { t: 1_000_000 };
    const cache = new SyncCache({ factory: () => factory, now: () => now.t, localStorage: memoryStorage, idle: () => {} });
    await cache.open(account);
    const store = new OutboxStore({ db: (purpose) => cache.outboxDatabase(undefined, purpose), now: () => now.t });
    return { cache, store, now, factory };
}

function row(localId: string, patch: Partial<OutboxRow> = {}): OutboxRow {
    return {
        localId, sid: 's1', body: `cipher-${localId}`, createdAt: 1_000_000, state: 'queued',
        attempts: 0, ownerTabId: 'tab-dead', group: `g-${localId}`, order: 0, ...patch,
    };
}

/** A lock that really serializes (Web Locks stand-in shared by "tabs"). */
function lock() {
    let tail: Promise<void> = Promise.resolve();
    return (fn: () => Promise<void>) => {
        const run = tail.then(fn);
        tail = run.catch(() => {});
        return run;
    };
}

describe('takeoverAction (Owner 10-25: ≤10 min re-send, older waits for the user)', () => {
    it('re-sends a queued row up to exactly 10 minutes old, never a failed one', () => {
        expect(takeoverAction({ state: 'queued', createdAt: 0 }, OUTBOX_AUTO_RESEND_MS)).toBe('resend');
        expect(takeoverAction({ state: 'queued', createdAt: 0 }, OUTBOX_AUTO_RESEND_MS + 1)).toBe('stale');
        expect(takeoverAction({ state: 'failed', createdAt: 0 }, 1)).toBe('stale');
        expect(OUTBOX_AUTO_RESEND_MS).toBe(600_000);
    });
});

describe('OutboxStore', () => {
    it('round-trips rows in the account database, ciphertext only; update and remove by localId', async () => {
        const { store } = await harness();
        expect(await store.put([row('a'), row('b', { order: 1 })])).toBe(true);
        expect((await store.all()).map((r) => r.localId).sort()).toEqual(['a', 'b']);
        expect(Object.keys((await store.all())[0]).sort()).toEqual(['attempts', 'body', 'createdAt', 'group', 'localId', 'order', 'ownerTabId', 'sid', 'state']);
        await store.update(['a', 'missing'], (r) => ({ ...r, state: 'failed' }));
        expect((await store.all()).find((r) => r.localId === 'a')?.state).toBe('failed');
        expect((await store.all()).some((r) => r.localId === 'missing')).toBe(false);
        // B-814b S4: a row the first send never persisted is written by a retry.
        await store.update(['a', 'late'], (r) => ({ ...r, attempts: r.attempts + 1 }), (id) => (id === 'late' ? row('late') : null));
        expect((await store.all()).map((r) => [r.localId, r.attempts]).sort()).toEqual([['a', 1], ['b', 0], ['late', 0]]);
        await store.remove(['late']);
        await store.remove(['a']);
        expect((await store.all()).map((r) => r.localId)).toEqual(['b']);
    });

    it('keeps call order: a put and the delete its ack triggers never swap', async () => {
        const { store } = await harness();
        const put = store.put([row('a')]);
        const removed = store.remove(['a']);
        await Promise.all([put, removed]);
        expect(await store.all()).toEqual([]);
    });

    it('accounts never see each other\'s outbox', async () => {
        const factory = new IDBFactory();
        const one = await harness(factory, 'account-1');
        await one.store.put([row('a')]);
        const two = await harness(factory, 'account-2');
        expect(await two.store.all()).toEqual([]);
    });

    it('deletes malformed rows instead of returning them', async () => {
        const { store, cache } = await harness();
        await store.put([row('a')]);
        const db = (await cache.outboxDatabase())!;
        const tx = db.transaction('outbox', 'readwrite');
        tx.objectStore('outbox').put({ localId: 'bad', sid: 's1' });
        await new Promise((resolve) => { tx.oncomplete = resolve; });
        expect((await store.all()).map((r) => r.localId)).toEqual(['a']);
        const check = db.transaction('outbox', 'readonly').objectStore('outbox').count();
        expect(await new Promise((resolve) => { check.onsuccess = () => resolve(check.result); })).toBe(1);
    });

    it('without a database (no IndexedDB / cache off) every call is a no-op, put reports not durable', async () => {
        const store = new OutboxStore({ db: async () => null });
        expect(await store.put([row('a')])).toBe(false);
        expect(await store.all()).toEqual([]);
        await expect(store.remove(['a'])).resolves.toBeUndefined();
    });

    it('B-814b S2: quota made the cache read-only — new rows are refused, but an ack still deletes its row', async () => {
        const { store, cache } = await harness();
        await store.put([row('acked'), row('kept')]);
        const message = (seq: number) => ({ id: `m${seq}`, seq, localId: null, content: { t: 'encrypted' as const, c: `Y2lwaGVy${seq}` }, createdAt: seq, updatedAt: seq });
        cache.offerLatest('s1', [message(1)], { viewed: true });
        await cache.flush();
        const put = IDBObjectStore.prototype.put;
        vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
            if (this.name === 'messages') throw new DOMException('quota', 'QuotaExceededError');
            return put.apply(this, args);
        });
        cache.offerNewer('s1', [message(2)]);
        await cache.flush();
        vi.restoreAllMocks();
        expect(cache.stats().readOnly).toBe(true);
        expect(await store.put([row('new')])).toBe(false);
        await store.remove(['acked']);
        const db = (await cache.outboxDatabase(undefined, 'delete'))!;
        const keys = db.transaction('outbox', 'readonly').objectStore('outbox').getAllKeys();
        expect(await new Promise((resolve) => { keys.onsuccess = () => resolve(keys.result); })).toEqual(['kept']);
    });

    it('B-819: one slow operation is not persisted, the next one is; only a run of them stops the outbox (with a metric)', async () => {
        const { cache } = await harness();
        const real = (await cache.outboxDatabase())!;
        let slow = 0;
        const hung = { transaction: () => ({ objectStore: () => ({ put: () => {} }), abort: () => {} }) } as unknown as IDBDatabase;
        const store = new OutboxStore({ db: async () => (slow > 0 ? (slow--, hung) : real) });
        const timedOut = async (localId: string) => {
            const op = store.put([row(localId)]);
            await vi.advanceTimersByTimeAsync(2_100);
            return op;
        };
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        slow = 1;
        expect(await timedOut('slow')).toBe(false);
        vi.useRealTimers();
        // Before B-819: false — the first timeout stopped the outbox for the page.
        expect(await store.put([row('next')])).toBe(true);
        expect(store.stats()).toMatchObject({ timeouts: 1, stuck: false });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        slow = OUTBOX_TIMEOUT_LIMIT;
        for (let i = 0; i < OUTBOX_TIMEOUT_LIMIT; i++) expect(await timedOut(`run-${i}`)).toBe(false);
        vi.useRealTimers();
        expect(store.stats()).toMatchObject({ timeouts: 1 + OUTBOX_TIMEOUT_LIMIT, stuck: true });
        expect(await store.put([row('after')])).toBe(false);
        expect((await store.all()).map((r) => r.localId)).toEqual([]);
    });

    it('the cache\'s session-deleted drop removes that session\'s outbox rows', async () => {
        const { store, cache } = await harness();
        await store.put([row('a'), row('b', { sid: 's2' })]);
        cache.dropSession('s1', 'deleted');
        await cache.flush();
        expect((await store.all()).map((r) => r.localId)).toEqual(['b']);
    });
});

describe('OutboxStore.takeOver (§5.5.3)', () => {
    it('takes only rows whose owner tab is gone; re-owns them; ≤10 min stay queued, older become failed', async () => {
        const { store, now } = await harness();
        now.t = 2_000_000;
        await store.put([
            row('fresh', { createdAt: now.t - 60_000 }),
            row('edge', { createdAt: now.t - OUTBOX_AUTO_RESEND_MS }),
            row('old', { createdAt: now.t - OUTBOX_AUTO_RESEND_MS - 1 }),
            row('failed', { createdAt: now.t - 1_000, state: 'failed' }),
            row('alive', { ownerTabId: 'tab-alive' }),
            row('mine', { ownerTabId: 'me' }),
        ]);
        const taken = await store.takeOver('me', async (tab) => tab === 'tab-alive', lock());
        const states = Object.fromEntries(taken.map((r) => [r.localId, r.state]));
        expect(states).toEqual({ fresh: 'queued', edge: 'queued', old: 'failed', failed: 'failed' });
        expect(taken.every((r) => r.ownerTabId === 'me')).toBe(true);
        const stored = Object.fromEntries((await store.all()).map((r) => [r.localId, `${r.ownerTabId}/${r.state}`]));
        expect(stored).toEqual({ fresh: 'me/queued', edge: 'me/queued', old: 'me/failed', failed: 'me/failed', alive: 'tab-alive/queued', mine: 'me/queued' });
        // The body is untouched: a re-send carries the same bytes under the same localId.
        expect(taken.find((r) => r.localId === 'fresh')?.body).toBe('cipher-fresh');
    });

    it('two tabs racing for the same orphans: exactly one takes each (re-read inside the lock)', async () => {
        const { store } = await harness();
        await store.put([row('a'), row('b')]);
        const alive = new Set(['tab-1', 'tab-2']);
        const shared = lock();
        const [one, two] = await Promise.all([
            store.takeOver('tab-1', async (tab) => alive.has(tab), shared),
            store.takeOver('tab-2', async (tab) => alive.has(tab), shared),
        ]);
        expect([...one, ...two].map((r) => r.localId).sort()).toEqual(['a', 'b']);
        expect(one.length === 0 || two.length === 0).toBe(true);
    });

    it('does nothing (no lock, no write) when every row belongs to this tab', async () => {
        const { store } = await harness();
        await store.put([row('a', { ownerTabId: 'me' })]);
        let locked = 0;
        const taken = await store.takeOver('me', async () => false, async (fn) => { locked += 1; await fn(); });
        expect(taken).toEqual([]);
        expect(locked).toBe(0);
    });

    it('asks once per owner tab, however many rows it left', async () => {
        const { store } = await harness();
        await store.put([row('a'), row('b'), row('c', { ownerTabId: 'tab-other' })]);
        const asked: string[] = [];
        await store.takeOver('me', async (tab) => { asked.push(tab); return false; }, lock());
        expect(asked.sort()).toEqual(['tab-dead', 'tab-other']);
    });
});
