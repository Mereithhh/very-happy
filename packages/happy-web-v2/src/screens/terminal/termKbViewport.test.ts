/**
 * Unit tests for the keyboard-viewport stabilizer + layout math.
 *
 * Regression anchor (2026-08-13): first keyboard open on iOS judders — the
 * open is an animation, visualViewport fires resize on many frames, and every
 * frame used to run maxHeight → ResizeObserver → refit → terminal-resize RPC
 * → tmux reflow. The stabilizer must collapse a whole animation burst into
 * exactly ONE stable callback (= one fit + one RPC), while per-frame CSS
 * follows the keyboard outside this module.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    COMPACT_VV_HEIGHT_PX,
    MOBILE_TYPO_BASE,
    MOBILE_TYPO_COMPACT,
    computeKbAvail,
    createViewportStabilizer,
    pickTermTypography,
} from './termKbViewport';

describe('createViewportStabilizer', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const make = (onStable: (h: number) => void, opts?: { quietMs?: number; maxWaitMs?: number }) =>
        createViewportStabilizer({ onStable, quietMs: 120, maxWaitMs: 600, ...opts });

    it('collapses an iOS keyboard-open animation burst into ONE stable callback', () => {
        const onStable = vi.fn();
        const s = make(onStable);
        // ~8 animation frames of a 250ms keyboard slide, height shrinking each frame
        const frames = [800, 760, 700, 640, 580, 530, 500, 490];
        for (const h of frames) {
            s.sample(h);
            expect(s.pending()).toBe(true);
            vi.advanceTimersByTime(16);
        }
        expect(onStable).not.toHaveBeenCalled(); // still animating
        vi.advanceTimersByTime(120); // quiet period after the last change
        expect(onStable).toHaveBeenCalledTimes(1);
        expect(onStable).toHaveBeenCalledWith(490); // the FINAL height
        expect(s.pending()).toBe(false);
    });

    it('fires quietMs after the LAST CHANGE, not the first sample', () => {
        const onStable = vi.fn();
        const s = make(onStable);
        s.sample(700);
        vi.advanceTimersByTime(100); // < quietMs, then the height moves again
        s.sample(500);
        vi.advanceTimersByTime(110);
        expect(onStable).not.toHaveBeenCalled(); // timer restarted at the change
        vi.advanceTimersByTime(10);
        expect(onStable).toHaveBeenCalledWith(500);
    });

    it('repeated UNCHANGED samples (vv scroll echoes) do not restart the quiet timer', () => {
        const onStable = vi.fn();
        const s = make(onStable);
        s.sample(500);
        for (let i = 0; i < 5; i++) {
            vi.advanceTimersByTime(20);
            s.sample(500); // same height — must not defer
        }
        vi.advanceTimersByTime(20); // total 120ms since the one real change
        expect(onStable).toHaveBeenCalledTimes(1);
    });

    it('hard cap: a never-quiet stream still fires by maxWaitMs from burst start', () => {
        const onStable = vi.fn();
        const s = make(onStable);
        let h = 800;
        s.sample(h);
        // height keeps changing every 50ms — quiet period never elapses
        for (let t = 0; t < 700; t += 50) {
            vi.advanceTimersByTime(50);
            h -= 5;
            s.sample(h);
        }
        expect(onStable).toHaveBeenCalledTimes(1); // fired at the 600ms cap
        // and the value is whatever the height was when the cap hit
        expect(onStable.mock.calls[0][0]).toBeLessThan(800);
    });

    it('cancel() drops the burst without firing (restore path takes over)', () => {
        const onStable = vi.fn();
        const s = make(onStable);
        s.sample(500);
        s.cancel();
        expect(s.pending()).toBe(false);
        vi.advanceTimersByTime(1000);
        expect(onStable).not.toHaveBeenCalled();
    });

    it('a new burst after firing works independently (second keyboard open)', () => {
        const onStable = vi.fn();
        const s = make(onStable);
        s.sample(500);
        vi.advanceTimersByTime(120);
        expect(onStable).toHaveBeenCalledTimes(1);
        s.sample(800); // keyboard closes/opens again
        s.sample(490);
        vi.advanceTimersByTime(120);
        expect(onStable).toHaveBeenCalledTimes(2);
        expect(onStable).toHaveBeenLastCalledWith(490);
    });
});

describe('computeKbAvail', () => {
    it('visible viewport minus host top, bars, and margin', () => {
        // iPhone-ish: vv 852→490 with keyboard, header puts hostTop at 56,
        // bars 46px, default 8px margin
        expect(computeKbAvail({ vvHeight: 490, vvOffsetTop: 0, hostTop: 56, barsHeight: 46 }))
            .toBe(490 - 56 - 46 - 8);
    });
    it('accounts for the iOS layout-viewport pan via vvOffsetTop', () => {
        expect(computeKbAvail({ vvHeight: 490, vvOffsetTop: 30, hostTop: 56, barsHeight: 46 }))
            .toBe(30 + 490 - 56 - 46 - 8);
    });
    it('honours a custom margin', () => {
        expect(computeKbAvail({ vvHeight: 400, vvOffsetTop: 0, hostTop: 50, barsHeight: 40, marginPx: 0 }))
            .toBe(310);
    });
});

describe('pickTermTypography', () => {
    it('compact type below the threshold, base at/above it', () => {
        expect(pickTermTypography(COMPACT_VV_HEIGHT_PX - 1)).toEqual(MOBILE_TYPO_COMPACT);
        expect(pickTermTypography(COMPACT_VV_HEIGHT_PX)).toEqual(MOBILE_TYPO_BASE);
        expect(pickTermTypography(800)).toEqual(MOBILE_TYPO_BASE);
    });
});
