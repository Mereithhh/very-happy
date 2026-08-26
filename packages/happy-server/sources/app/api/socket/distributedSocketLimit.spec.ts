import { describe, expect, it, vi } from 'vitest';
import { DistributedSocketConnectionLimiter } from './distributedSocketLimit';

describe('DistributedSocketConnectionLimiter', () => {
    it('uses one account-scoped atomic Redis lease set across slots', async () => {
        const redis = {
            eval: vi.fn(async () => 1),
            zrem: vi.fn(async () => 1),
        } as any;
        const limiter = new DistributedSocketConnectionLimiter(redis, 128, 60_000);
        await expect(limiter.acquire('account-a', 'green:socket-1', 1_000)).resolves.toBe(true);
        expect(redis.eval).toHaveBeenCalledWith(
            expect.stringContaining("ZREMRANGEBYSCORE"),
            1,
            'vh:socket-connections:account-a',
            1_000,
            61_000,
            'green:socket-1',
            128,
        );
        await limiter.release('account-a', 'green:socket-1');
        expect(redis.zrem).toHaveBeenCalledWith('vh:socket-connections:account-a', 'green:socket-1');
    });

    it('fails admission when the shared cap is exhausted', async () => {
        const limiter = new DistributedSocketConnectionLimiter({ eval: vi.fn(async () => 0) } as any, 1);
        await expect(limiter.acquire('account-a', 'blue:socket-2')).resolves.toBe(false);
    });
});
