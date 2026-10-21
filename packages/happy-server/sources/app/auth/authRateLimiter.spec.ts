import { describe, expect, it, vi } from 'vitest';
import { allowAuthRequest, resetAuthRateLimiterCleanupForTests, retryAfterSecondsForBuckets } from './authRateLimiter';

/**
 * Wiring only. The limiter's SEMANTICS live in the SQL and are covered against
 * a real Postgres in authRateLimiterSelfLock.pglite.integration.spec.ts — a
 * mock that returns whatever we tell it can only restate the implementation.
 */
describe('shared authentication rate limiter', () => {
    it('charges the bucket atomically, with the ceiling inside the same statement', async () => {
        resetAuthRateLimiterCleanupForTests();
        const query = vi.fn().mockResolvedValue([{ count: 1 }]);
        const client = { $queryRawUnsafe: query, $executeRawUnsafe: vi.fn(async () => 0) } as any;

        await expect(allowAuthRequest('google:ip', { max: 2, windowMs: 60_000 }, client, 1_000)).resolves.toBe(true);

        const sql = query.mock.calls[0][0];
        expect(sql).toContain('ON CONFLICT ("key") DO UPDATE');
        expect(sql).toContain('"count" + $4');
        // B-307: the ceiling is enforced by the UPSERT's own WHERE, so a
        // refused request updates nothing. Checking it in JS after an
        // unconditional increment is what let refused retries drain the
        // account's budget.
        expect(sql).toContain('OR "AuthRateLimitBucket"."count" + $4 <= $5');
        expect(query.mock.calls[0][4]).toBe(1);   // $4 = cost
        expect(query.mock.calls[0][5]).toBe(2);   // $5 = max
    });

    it('passes the weighted batch cost, and reads refusal from an empty result', async () => {
        const query = vi.fn().mockResolvedValue([]);
        const client = { $queryRawUnsafe: query, $executeRawUnsafe: vi.fn(async () => 0) } as any;

        await expect(allowAuthRequest('message:user-1', { max: 6, windowMs: 60_000, cost: 5 }, client, 2_000))
            .resolves.toBe(false);
        expect(query.mock.calls[0][4]).toBe(5);
        expect(query.mock.calls[0][0]).toContain('THEN $4');
    });

    it('refuses a request costlier than the whole window without touching the database', async () => {
        const query = vi.fn();
        const client = { $queryRawUnsafe: query, $executeRawUnsafe: vi.fn(async () => 0) } as any;

        await expect(allowAuthRequest('message:user-1', { max: 6, windowMs: 60_000, cost: 7 }, client, 3_000))
            .resolves.toBe(false);
        expect(query).not.toHaveBeenCalled();
    });
});

describe('B-668 retry-after from bucket rows', () => {
    const now = 1_000_000;
    const buckets = [
        { key: 'a', max: 3, windowMs: 60_000 },
        { key: 'b', max: 10, windowMs: 86_400_000 },
        { key: 'c', max: 5, windowMs: 3_600_000 },
    ];

    it('takes the longest reset among buckets that cannot take one more request', () => {
        expect(retryAfterSecondsForBuckets(buckets, [
            { key: 'a', count: 3, resetAt: new Date(now + 30_000) },
            { key: 'b', count: 10, resetAt: new Date(now + 82_800_000) },
            { key: 'c', count: 5, resetAt: new Date(now + 600_000) },
        ], now)).toBe(82_800);
    });

    it('ignores buckets with room left, expired rows, and unknown keys', () => {
        expect(retryAfterSecondsForBuckets(buckets, [
            { key: 'a', count: 3, resetAt: new Date(now + 29_001) },
            { key: 'b', count: 9n, resetAt: new Date(now + 82_800_000) },
            { key: 'c', count: 5, resetAt: new Date(now - 1) },
            { key: 'zzz', count: 99, resetAt: new Date(now + 999_999_000) },
        ], now)).toBe(30);
    });

    it('honours per-bucket cost and never answers below one second', () => {
        expect(retryAfterSecondsForBuckets([{ key: 'w', max: 6, cost: 5 }], [
            { key: 'w', count: 2, resetAt: new Date(now + 4_000).toISOString() },
        ], now)).toBe(4);
        expect(retryAfterSecondsForBuckets(buckets, [], now)).toBe(1);
    });
});
