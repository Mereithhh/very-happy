import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityCache, activityCache, sessionActivityUpdateWhere } from './sessionCache';

/**
 * B-587 regression (found by the live hibernation run): a heartbeat batched
 * just before a wrapper went offline was flushed AFTER `session-end` /
 * `/deactivate`, writing `active: true` back — the session looked live with no
 * process behind it. The rows below are a tiny in-memory `session` table that
 * applies the real `where` predicates, so these are behaviour tests.
 */
const row = vi.hoisted(() => ({ id: 's1', archivedAt: null as Date | null, active: true, lastActiveAt: new Date(0) }));
const gate = vi.hoisted(() => ({ hold: null as Promise<void> | null }));
const matches = (where: any): boolean => {
    if (where.id !== row.id) return false;
    if (where.archivedAt === null && row.archivedAt !== null) return false;
    if (where.lastActiveAt?.lt && !(row.lastActiveAt.getTime() < where.lastActiveAt.lt.getTime())) return false;
    return true;
};
vi.mock('@/storage/db', () => ({
    db: {
        session: {
            findUnique: vi.fn(async () => ({ ...row })),
            updateMany: vi.fn(async ({ where, data }: any) => {
                if (gate.hold) await gate.hold; // an UPDATE already in flight
                if (!matches(where)) return { count: 0 };
                Object.assign(row, data);
                return { count: 1 };
            }),
        },
        machine: { updateMany: vi.fn() },
    },
}));
vi.mock('@/utils/log', () => ({ log: vi.fn() }));
vi.mock('@/app/monitoring/metrics2', () => ({ sessionCacheCounter: { inc: vi.fn() }, databaseUpdatesSkippedCounter: { inc: vi.fn() } }));

type Flushable = { flushPendingUpdates(): Promise<void> };
const flush = (cache: unknown) => (cache as Flushable).flushPendingUpdates();
/** what session-end / deactivate write (server clock) */
const goOffline = (at: number) => { Object.assign(row, { active: false, lastActiveAt: new Date(at) }); };
const caches: ActivityCache[] = [];
const fresh = () => { const c = new ActivityCache(); caches.push(c); return c; };

afterEach(() => {
    for (const c of caches.splice(0)) c.shutdown();
    Object.assign(row, { archivedAt: null, active: true, lastActiveAt: new Date(0) });
    gate.hold = null;
});

describe('presence batch vs the offline transition (B-587)', () => {
    it('discarded on this instance → never flushed', async () => {
        const cache = fresh();
        await cache.isSessionValid('s1', 'u1');
        expect(cache.queueSessionUpdate('s1', 1_000_000, 1_000_000)).toBe(true);
        cache.discardSessionUpdate('s1');
        goOffline(1_000_500);
        await flush(cache);
        expect(row.active).toBe(false);
    });

    it('a flush ALREADY IN FLIGHT when the offline write lands cannot re-activate the row', async () => {
        const cache = fresh();
        await cache.isSessionValid('s1', 'u1');
        cache.queueSessionUpdate('s1', 1_000_000, 1_000_000);
        let release!: () => void;
        gate.hold = new Promise<void>((resolve) => { release = resolve; });
        const inFlight = flush(cache);          // collected the beat, UPDATE pending
        cache.discardSessionUpdate('s1');       // too late for this one
        goOffline(1_000_400);                   // the offline write commits first
        release();
        await inFlight;
        expect(row.active).toBe(false);
        expect(row.lastActiveAt.getTime()).toBe(1_000_400);
    });

    it('a beat queued on ANOTHER instance (multi-instance / blue-green slot) is stopped too', async () => {
        const a = fresh();
        const b = fresh();
        await b.isSessionValid('s1', 'u1');
        b.queueSessionUpdate('s1', 2_000_000, 2_000_000);
        a.discardSessionUpdate('s1');           // the offline request hit instance A
        goOffline(2_000_300);
        await flush(b);
        expect(row.active).toBe(false);
    });

    it("a resumed session's beats are written — even from a wrapper whose clock lags the server", async () => {
        const cache = fresh();
        goOffline(3_000_000);
        Object.assign(row, { lastActiveAt: new Date(3_000_500) }); // reactivation write (server now)
        await cache.isSessionValid('s1', 'u1');
        // client clock 40 s behind: its timestamp predates the reactivation, the arrival does not
        expect(cache.queueSessionUpdate('s1', 2_960_600, 3_000_600)).toBe(true);
        await flush(cache);
        expect(row.active).toBe(true);
        expect(row.lastActiveAt.getTime()).toBe(2_960_600);
    });

    it('the predicate: archive tombstone + monotonic receive time', () => {
        expect(sessionActivityUpdateWhere('s1', 5)).toEqual({ id: 's1', archivedAt: null, lastActiveAt: { lt: new Date(5) } });
        expect(activityCache).toBeInstanceOf(ActivityCache);
    });
});
