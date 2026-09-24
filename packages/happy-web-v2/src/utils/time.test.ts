import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthFailedError, resetAuthLatch, tripAuthLatch } from '@/auth/authLatch';
import { createBackoff, exponentialBackoffDelay } from './time';

afterEach(() => {
    resetAuthLatch();
    vi.restoreAllMocks();
});

describe('exponentialBackoffDelay (B-490)', () => {
    it('grows exponentially and is capped (the old formula was a flat 0–1 s forever)', () => {
        const top = () => 0.999999;
        const delays = [1, 2, 3, 4, 5, 10, 60].map((n) => exponentialBackoffDelay(n, 250, 10_000, top));
        expect(delays).toEqual([250, 500, 1000, 2000, 4000, 10_000, 10_000]);
        // jitter never drops below half the ceiling
        expect(exponentialBackoffDelay(4, 250, 10_000, () => 0)).toBe(1000);
    });
});

describe('createBackoff (B-490)', () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => { sleeps.push(ms); };
    afterEach(() => { sleeps.length = 0; });

    it('401 is not retried: one call, the AuthFailedError propagates', async () => {
        const call = vi.fn(async () => { throw new AuthFailedError(401); });
        await expect(createBackoff({ sleep })(call)).rejects.toBeInstanceOf(AuthFailedError);
        expect(call).toHaveBeenCalledTimes(1);
        expect(sleeps).toEqual([]);
    });

    it('403 (axios shape) is not retried either', async () => {
        const call = vi.fn(async () => { throw Object.assign(new Error('x'), { response: { status: 403 } }); });
        await expect(createBackoff({ sleep })(call)).rejects.toBeTruthy();
        expect(call).toHaveBeenCalledTimes(1);
    });

    it('once the latch trips mid-loop (a generic error after the guard saw 401) the loop stops', async () => {
        const call = vi.fn(async () => {
            tripAuthLatch({ status: 401, path: '/v1/friends' });
            throw new Error('Failed to fetch friends: 401');
        });
        await expect(createBackoff({ sleep })(call)).rejects.toBeInstanceOf(AuthFailedError);
        expect(call).toHaveBeenCalledTimes(1);
    });

    it('does not call the server at all while latched', async () => {
        tripAuthLatch({ status: 401 });
        const call = vi.fn(async () => 'ok');
        await expect(createBackoff({ sleep })(call)).rejects.toBeInstanceOf(AuthFailedError);
        expect(call).not.toHaveBeenCalled();
    });

    it('transient errors retry with growing delays and stop at maxAttempts', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.999999);
        const call = vi.fn(async () => { throw new Error('Failed: 502'); });
        await expect(createBackoff({ sleep, minDelay: 500, maxDelay: 15_000, maxAttempts: 5 })(call)).rejects.toThrow('502');
        expect(call).toHaveBeenCalledTimes(5);
        expect(sleeps).toEqual([500, 1000, 2000, 4000]);
    });

    it('still succeeds after transient errors', async () => {
        let n = 0;
        const call = vi.fn(async () => { if (++n < 3) throw new Error('flaky'); return 'ok'; });
        await expect(createBackoff({ sleep })(call)).resolves.toBe('ok');
        expect(call).toHaveBeenCalledTimes(3);
    });
});
