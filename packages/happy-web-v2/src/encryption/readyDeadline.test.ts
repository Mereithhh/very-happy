import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadyTimeoutError, readyWithin } from './readyDeadline';

function deferred() {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve)).then(() => Promise.resolve());

describe('readyWithin (B-859b)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('resolves as soon as ready resolves within the deadline', async () => {
        const d = deferred();
        const wait = readyWithin(d.promise, 12_000, 'libsodium');
        let done = false;
        void wait().then(() => { done = true; });
        await vi.advanceTimersByTimeAsync(2_000);
        expect(done).toBe(false);
        d.resolve();
        await flush();
        expect(done).toBe(true);
    });

    it('rejects with ReadyTimeoutError when ready never settles, instead of hanging', async () => {
        const wait = readyWithin(new Promise<void>(() => {}), 12_000, 'libsodium');
        const result = wait().then(() => 'resolved', (e) => e);
        await vi.advanceTimersByTimeAsync(11_999);
        await flush();
        const early = await Promise.race([result, Promise.resolve('pending')]);
        expect(early).toBe('pending');
        await vi.advanceTimersByTimeAsync(1);
        const e = await result;
        expect(e).toBeInstanceOf(ReadyTimeoutError);
        expect((e as Error).message).toBe('libsodium not ready after 12000ms');
    });

    it('measures the deadline from creation, so retries after it fail fast rather than waiting again', async () => {
        const wait = readyWithin(new Promise<void>(() => {}), 12_000, 'libsodium');
        await vi.advanceTimersByTimeAsync(20_000);
        const t0 = Date.now();
        const e = await wait().then(() => null, (err) => err);
        expect(e).toBeInstanceOf(ReadyTimeoutError);
        expect(Date.now() - t0).toBe(0);
    });

    it('a ready that arrives after the deadline still lets the next call succeed', async () => {
        const d = deferred();
        const wait = readyWithin(d.promise, 12_000, 'libsodium');
        const first = wait().then(() => 'resolved', (e) => e);
        await vi.advanceTimersByTimeAsync(12_000);
        expect(await first).toBeInstanceOf(ReadyTimeoutError);
        d.resolve();
        await flush();
        await expect(wait()).resolves.toBeUndefined();
    });

    it('propagates a ready rejection', async () => {
        const d = deferred();
        const wait = readyWithin(d.promise, 12_000, 'libsodium');
        const err = new Error('wasm failed');
        const result = wait().then(() => null, (e) => e);
        d.reject(err);
        expect(await result).toBe(err);
    });
});
