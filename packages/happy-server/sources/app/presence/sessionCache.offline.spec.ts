import { afterAll, describe, expect, it, vi } from 'vitest';
import { activityCache } from './sessionCache';

/**
 * B-587 regression (found by the live hibernation run): a heartbeat queued in
 * the 5 s presence batch just before a wrapper went offline was flushed AFTER
 * `session-end` / `/deactivate`, writing `active: true` back — the session
 * looked live with no process behind it. The offline transition now discards
 * the pending beat; this pins the cache half of that contract.
 */
const updateMany = vi.hoisted(() => vi.fn(async () => ({ count: 1 })));
vi.mock('@/storage/db', () => ({
    db: { session: { findUnique: vi.fn(async () => ({ id: 's1', lastActiveAt: new Date(0) })), updateMany }, machine: { updateMany: vi.fn() } },
}));
vi.mock('@/utils/log', () => ({ log: vi.fn() }));
vi.mock('@/app/monitoring/metrics2', () => ({ sessionCacheCounter: { inc: vi.fn() }, databaseUpdatesSkippedCounter: { inc: vi.fn() } }));

afterAll(() => activityCache.shutdown());

describe('presence batch vs the offline transition', () => {
    it('a beat discarded by the offline write is never flushed as active', async () => {
        expect(await activityCache.isSessionValid('s1', 'u1')).toBe(true);
        expect(activityCache.queueSessionUpdate('s1', Date.now())).toBe(true);
        activityCache.discardSessionUpdate('s1'); // what session-end / deactivate now do
        await (activityCache as unknown as { flushPendingUpdates(): Promise<void> }).flushPendingUpdates();
        expect(updateMany).not.toHaveBeenCalled();
    });
    it('without the discard the queued beat WOULD re-activate the row (the bug)', async () => {
        expect(activityCache.queueSessionUpdate('s1', Date.now() + 60_000)).toBe(true);
        await (activityCache as unknown as { flushPendingUpdates(): Promise<void> }).flushPendingUpdates();
        expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ active: true }) }));
    });
});
