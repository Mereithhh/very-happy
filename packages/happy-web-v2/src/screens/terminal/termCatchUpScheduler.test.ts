import { describe, expect, it } from 'vitest';
import {
    backoffDelayMs,
    beginRetry,
    CATCH_UP_MAX_ATTEMPTS,
    completeCatchUp,
    initialCatchUpState,
    requestCatchUp,
} from './termCatchUpScheduler';

describe('termCatchUpScheduler', () => {
    it('starts from idle and queues a merged again while inflight', () => {
        let r = requestCatchUp(initialCatchUpState(), {}, 0);
        expect(r.result).toBe('start');
        expect(r.state.phase).toBe('inflight');
        let q = requestCatchUp(r.state, {}, 10);
        expect(q.result).toBe('queued');
        q = requestCatchUp(q.state, { forceSnapshot: true }, 20);
        expect(q.result).toBe('queued');
        expect(q.state.again).toEqual({ forceSnapshot: true }); // opts are not dropped
        const c = completeCatchUp(q.state, 'ok', 100);
        expect(c.result).toEqual({ action: 'start', opts: { forceSnapshot: true } });
        expect(c.state.phase).toBe('inflight');
    });

    it('dedupes coalescable triggers within 1s of a success; gap (plain) and forceSnapshot always run', () => {
        let s = requestCatchUp(initialCatchUpState(), {}, 0).state;
        s = completeCatchUp(s, 'ok', 1000).state;
        expect(requestCatchUp(s, { coalesce: true }, 1500).result).toBe('ignored');
        expect(requestCatchUp(s, {}, 1500).result).toBe('start'); // a gap chunk proves a newer hole
        expect(requestCatchUp(s, { forceSnapshot: true, coalesce: true }, 1500).result).toBe('start');
        expect(requestCatchUp(s, { coalesce: true }, 2001).result).toBe('start');
    });

    it('a failure backs off instead of re-firing immediately, folding the queued again into the retry', () => {
        let s = requestCatchUp(initialCatchUpState(), {}, 0).state;
        s = requestCatchUp(s, { forceSnapshot: true }, 5).state; // queued while inflight
        const c = completeCatchUp(s, 'fail', 100);
        expect(c.result).toEqual({ action: 'retry', delayMs: 1000, opts: { forceSnapshot: true } });
        expect(c.state.phase).toBe('backoff');
        expect(c.state.again).toBeNull(); // single retry source: no immediate re-run
        const inflight = beginRetry(c.state);
        expect(inflight.phase).toBe('inflight');
        const c2 = completeCatchUp(inflight, 'fail', 1200);
        expect(c2.result).toMatchObject({ action: 'retry', delayMs: 2000 });
    });

    it('backoff doubles and caps at 15s, then gives up after MAX_ATTEMPTS', () => {
        expect([1, 2, 3, 4, 5, 6].map(backoffDelayMs)).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
        let s = requestCatchUp(initialCatchUpState(), {}, 0).state;
        let last: ReturnType<typeof completeCatchUp> | null = null;
        for (let i = 0; i < CATCH_UP_MAX_ATTEMPTS; i++) {
            last = completeCatchUp(s, 'fail', i);
            s = beginRetry(last.state);
        }
        expect(last!.result).toEqual({ action: 'stop' });
        expect(last!.state.phase).toBe('idle');
        // A fresh trigger starts again from attempt 0.
        const again = requestCatchUp(last!.state, {}, 100);
        expect(again.result).toBe('start');
        expect(again.state.attempt).toBe(0);
    });

    it('a new trigger during backoff resets the backoff and starts now', () => {
        let s = requestCatchUp(initialCatchUpState(), {}, 0).state;
        s = completeCatchUp(s, 'fail', 1).state;
        s = beginRetry(s);
        s = completeCatchUp(s, 'fail', 2).state; // attempt 2, backoff
        const r = requestCatchUp(s, {}, 3);
        expect(r.result).toBe('start');
        expect(r.state.attempt).toBe(0);
    });

    it('gone is terminal; aborted (disposed/remount) stops without retry', () => {
        let s = requestCatchUp(initialCatchUpState(), {}, 0).state;
        const gone = completeCatchUp(s, 'gone', 1);
        expect(gone.result).toEqual({ action: 'stop' });
        expect(requestCatchUp(gone.state, { forceSnapshot: true }, 2).result).toBe('ignored');
        s = requestCatchUp(initialCatchUpState(), {}, 0).state;
        s = requestCatchUp(s, {}, 1).state;
        const aborted = completeCatchUp(s, 'aborted', 2);
        expect(aborted.result).toEqual({ action: 'stop' });
        expect(aborted.state.phase).toBe('idle');
        expect(aborted.state.again).toBeNull();
    });
});
