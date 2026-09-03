import { describe, expect, it, vi } from 'vitest';
import { allowAuthRequest, resetAuthRateLimiterCleanupForTests } from './authRateLimiter';

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
