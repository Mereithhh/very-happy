import { describe, expect, it, vi } from 'vitest';
import { allowAuthRequest, resetAuthRateLimiterCleanupForTests } from './authRateLimiter';

describe('shared authentication rate limiter', () => {
    it('uses the atomic database count and rejects requests beyond the limit', async () => {
        resetAuthRateLimiterCleanupForTests();
        const query = vi.fn()
            .mockResolvedValueOnce([{ count: 1 }])
            .mockResolvedValueOnce([{ count: 2 }])
            .mockResolvedValueOnce([{ count: 3 }]);
        const execute = vi.fn().mockResolvedValue(0);
        const client = { $queryRawUnsafe: query, $executeRawUnsafe: execute } as any;

        await expect(allowAuthRequest('google:ip', { max: 2, windowMs: 60_000 }, client, 1_000)).resolves.toBe(true);
        await expect(allowAuthRequest('google:ip', { max: 2, windowMs: 60_000 }, client, 1_001)).resolves.toBe(true);
        await expect(allowAuthRequest('google:ip', { max: 2, windowMs: 60_000 }, client, 1_002)).resolves.toBe(false);
        expect(query.mock.calls[0][0]).toContain('ON CONFLICT ("key") DO UPDATE');
        expect(query.mock.calls[0][0]).toContain('"count" + $4');
        expect(query.mock.calls[0][4]).toBe(1);
    });

    it('charges weighted batch cost atomically', async () => {
        const query = vi.fn().mockResolvedValue([{ count: 7 }]);
        const client = { $queryRawUnsafe: query, $executeRawUnsafe: vi.fn(async () => 0) } as any;

        await expect(allowAuthRequest('message:user-1', { max: 6, windowMs: 60_000, cost: 5 }, client, 2_000))
            .resolves.toBe(false);
        expect(query.mock.calls[0][4]).toBe(5);
        expect(query.mock.calls[0][0]).toContain('THEN $4');
    });
});
