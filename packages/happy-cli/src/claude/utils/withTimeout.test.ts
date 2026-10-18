import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimeoutError, withTimeout } from './withTimeout';

describe('withTimeout (B-631)', () => {
    // Only the timers withTimeout uses; setImmediate stays real so the
    // unhandledRejection probe below can actually run a macrotask.
    beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
    afterEach(() => { vi.useRealTimers(); });

    it('passes a value that arrives in time through and clears its timer', async () => {
        const result = withTimeout(Promise.resolve('ok'), 1000, 'probe');
        await expect(result).resolves.toBe('ok');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects with a TimeoutError naming the label and budget when the promise is late', async () => {
        const never = new Promise<string>(() => {});
        const result = withTimeout(never, 3000, 'interrupt');
        const settled = result.then(
            () => { throw new Error('resolved'); },
            (error: unknown) => error,
        );
        await vi.advanceTimersByTimeAsync(3000);
        const error = await settled;
        expect(error).toBeInstanceOf(TimeoutError);
        expect((error as Error).message).toBe('interrupt timed out after 3000ms');
    });

    it('propagates the promise rejection when it comes first, which is not a TimeoutError', async () => {
        const error = await withTimeout(Promise.reject(new Error('refused')), 1000).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(TimeoutError);
        expect((error as Error).message).toBe('refused');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps a rejection that lands after the deadline handled', async () => {
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        try {
            let rejectLate!: (error: Error) => void;
            const late = new Promise<void>((_, reject) => { rejectLate = reject; });
            const result = withTimeout(late, 10);
            const settled = expect(result).rejects.toThrow('timed out after 10ms');
            await vi.advanceTimersByTimeAsync(10);
            await settled;
            rejectLate(new Error('too late'));
            await vi.advanceTimersByTimeAsync(0);
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(unhandled).not.toHaveBeenCalled();
        } finally {
            process.off('unhandledRejection', unhandled);
        }
    });
});
