import { describe, expect, it } from 'vitest';
import {
    createTouchFling,
    scaleTouchTuiScrollLines,
    stopSyntheticScrollForBufferChange,
} from './termTouchFling';

describe('scaleTouchTuiScrollLines', () => {
    it('amplifies alternate-screen touch rows in both directions without changing zero', () => {
        expect(scaleTouchTuiScrollLines(2)).toBe(6);
        expect(scaleTouchTuiScrollLines(-2)).toBe(-6);
        expect(scaleTouchTuiScrollLines(0)).toBe(0);
    });

    it('rejects non-finite input at the touch boundary', () => {
        expect(scaleTouchTuiScrollLines(Number.NaN)).toBe(0);
        expect(scaleTouchTuiScrollLines(Number.POSITIVE_INFINITY)).toBe(0);
    });
});

describe('createTouchFling', () => {
    const harness = () => {
        const emitted: number[] = [];
        const frames: Array<(at: number) => void> = [];
        const fling = createTouchFling({
            emit: (px) => emitted.push(px),
            schedule: (frame) => { frames.push(frame); return frames.length; },
            cancelFrame: () => {},
        });
        return { fling, emitted, frames };
    };

    it('adds conservative Termux-style momentum after a recent drag', () => {
        const h = harness();
        h.fling.sample(10, 100);
        h.fling.sample(12, 116); // 0.75 px/ms, release gain = 0.25
        expect(h.fling.release(120)).toBe(true);
        expect(h.fling.active()).toBe(true);
        h.frames.shift()?.(136);
        expect(h.emitted[0]).toBeGreaterThan(2);
        expect(h.emitted[0]).toBeLessThan(4);
    });

    it('does not fling stale, tiny, or missing movement', () => {
        const h = harness();
        expect(h.fling.release(100)).toBe(false);
        h.fling.sample(1, 100);
        h.fling.sample(1, 200); // 0.01 px/ms -> below threshold after gain
        expect(h.fling.release(201)).toBe(false);
        h.fling.sample(20, 300);
        h.fling.sample(20, 316);
        expect(h.fling.release(500)).toBe(false);
    });

    it('cancels active momentum when a new touch begins', () => {
        const h = harness();
        h.fling.sample(-20, 100);
        h.fling.sample(-20, 116);
        expect(h.fling.release(120)).toBe(true);
        h.fling.cancel();
        expect(h.fling.active()).toBe(false);
    });
});

describe('stopSyntheticScrollForBufferChange', () => {
    it('cancels alternate-buffer momentum and its unsent RPC batch before normal-buffer input resumes', () => {
        const calls: string[] = [];
        stopSyntheticScrollForBufferChange({
            cancelFling: () => calls.push('cancel-fling'),
            clearPendingBatch: () => calls.push('clear-pending-batch'),
        });
        expect(calls).toEqual(['cancel-fling', 'clear-pending-batch']);
    });
});
