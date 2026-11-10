import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReconnectUpdateCheck, RECONNECT_CHECK_DELAYS_MS } from './reconnectUpdateCheck';

describe('createReconnectUpdateCheck (B-914)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    function setup(found = () => false) {
        const check = vi.fn();
        const trigger = createReconnectUpdateCheck({
            check,
            found,
            setTimer: (fn, ms) => setTimeout(fn, ms),
            clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        });
        return { check, trigger };
    }

    it('checks at once on a reconnect, then keeps looking while the edge flips — all within 30s', () => {
        const { check, trigger } = setup();
        trigger();
        vi.advanceTimersByTime(0);
        expect(check).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(30_000);
        expect(check).toHaveBeenCalledTimes(RECONNECT_CHECK_DELAYS_MS.length);
        expect(Math.max(...RECONNECT_CHECK_DELAYS_MS)).toBeLessThan(30_000);
    });

    it('stops once an update has been found', () => {
        let found = false;
        const { check, trigger } = setup(() => found);
        trigger();
        vi.advanceTimersByTime(0);
        found = true;
        vi.advanceTimersByTime(30_000);
        expect(check).toHaveBeenCalledTimes(1);
    });

    it('a flapping link restarts the burst instead of stacking another one', () => {
        const { check, trigger } = setup();
        trigger();
        vi.advanceTimersByTime(1_000);
        trigger();
        vi.advanceTimersByTime(30_000);
        // 1 from the first burst (t=0), then the full second burst.
        expect(check).toHaveBeenCalledTimes(1 + RECONNECT_CHECK_DELAYS_MS.length);
    });
});
