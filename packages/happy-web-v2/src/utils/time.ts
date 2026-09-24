import { AuthFailedError, getAuthLatch, isAuthFailure } from '@/auth/authLatch';

export async function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Capped exponential delay with jitter: minDelay·2^(n-1), capped at maxDelay,
 * then a random point in [50%, 100%] of that.
 *
 * B-490: the inherited formula used `Math.max(currentFailureCount,
 * maxFailureCount)`, so it was ALWAYS the max — a flat random 0–1000 ms, i.e.
 * ~2 requests/s per retry loop forever. That is what turned a dead token into
 * a sustained request storm.
 */
export function exponentialBackoffDelay(currentFailureCount: number, minDelay: number, maxDelay: number, random: () => number = Math.random) {
    const exponent = Math.max(0, currentFailureCount - 1);
    const ceiling = Math.min(maxDelay, minDelay * Math.pow(2, Math.min(exponent, 30)));
    return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

export type BackoffFunc = <T>(callback: () => Promise<T>) => Promise<T>;

export interface BackoffOptions {
    onError?: (e: any, failuresCount: number) => void,
    minDelay?: number,
    maxDelay?: number,
    /** total attempts before the last error is rethrown; default: unlimited */
    maxAttempts?: number,
    /** injectable for tests */
    sleep?: (ms: number) => Promise<unknown>,
}

/**
 * Retry `callback` with capped exponential backoff.
 *
 * Never retried (B-490): auth failures (401/403 — `isAuthFailure`) are
 * rethrown immediately, and once the account auth latch has tripped every
 * loop stops with an AuthFailedError instead of calling the server again.
 */
export function createBackoff(opts?: BackoffOptions): BackoffFunc {
    return async <T>(callback: () => Promise<T>): Promise<T> => {
        let currentFailureCount = 0;
        const minDelay = opts?.minDelay ?? 250;
        const maxDelay = opts?.maxDelay ?? 10_000;
        const maxAttempts = opts?.maxAttempts ?? Infinity;
        const sleep = opts?.sleep ?? delay;
        while (true) {
            const latch = getAuthLatch();
            if (latch) throw new AuthFailedError(latch.status, 'auth latched: retry loop stopped');
            try {
                return await callback();
            } catch (e) {
                if (isAuthFailure(e)) throw e;
                const latchAfter = getAuthLatch();
                if (latchAfter) throw new AuthFailedError(latchAfter.status, 'auth latched: retry loop stopped');
                currentFailureCount++;
                if (opts?.onError) {
                    opts.onError(e, currentFailureCount);
                }
                if (currentFailureCount >= maxAttempts) throw e;
                await sleep(exponentialBackoffDelay(currentFailureCount, minDelay, maxDelay));
            }
        }
    };
}

export let backoff = createBackoff({ onError: (e) => { console.warn(e); } });
