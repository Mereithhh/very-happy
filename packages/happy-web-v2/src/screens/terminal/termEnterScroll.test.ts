/**
 * termEnterScroll — classifier + guard tests.
 *
 * The numbers in the samples are not invented: they are the values a real
 * xterm 5.5 in real Chromium reported for each situation (T-009 probe,
 * ~/code/github/skills/tmp/vh-t009-enter-scroll/probe2.mjs / probe-fix.mjs:
 * 13px Menlo → 15px rows, 1000×800 viewport). Before the guard, the two
 * "container grows" cases left `viewportY = baseY - 20` with
 * `isUserScrolling = true` and live output no longer following; the same
 * sequences with the guard wired end at the tail.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    classifyViewportScroll,
    createTailFollowGuard,
    isXtermViewport,
    SCROLL_MAX_TOLERANCE_PX,
    type ViewportScrollSample,
} from './termEnterScroll';

/** Buffer at the tail, DOM at its maximum. rows=52, 15px rows. */
const AT_TAIL: ViewportScrollSample = {
    viewportY: 3641, baseY: 3641, scrollTop: 54615, scrollHeight: 55399, clientHeight: 784,
};

describe('classifyViewportScroll', () => {
    it('a clamp after the container GREW: still at max, buffer at tail → layout', () => {
        // bars 300px → 0: clientHeight 784 → 1084, browser clamps scrollTop to the
        // new max (54315) and fires scroll; xterm would read that as wheel-up.
        expect(classifyViewportScroll({
            viewportY: 3641, baseY: 3641, scrollTop: 54315, scrollHeight: 55399, clientHeight: 1084,
        })).toBe('layout');
    });

    it('a clamp after the scroll area SHRANK under a tail viewport → layout', () => {
        // term.reset() between a 4000-line buffer and its 300-line replacement:
        // scrollTop 63255 → 0 while the buffer is still empty (ydisp = ybase = 0).
        expect(classifyViewportScroll({
            viewportY: 0, baseY: 0, scrollTop: 0, scrollHeight: 784, clientHeight: 784,
        })).toBe('layout');
        // …or already partially re-filled (ydisp = ybase = 248, max = 3720).
        expect(classifyViewportScroll({
            viewportY: 248, baseY: 248, scrollTop: 3720, scrollHeight: 4504, clientHeight: 784,
        })).toBe('layout');
    });

    it('the user wheels UP from the tail: below max → user', () => {
        expect(classifyViewportScroll({ ...AT_TAIL, scrollTop: 54465 })).toBe('user');
        expect(classifyViewportScroll({ ...AT_TAIL, scrollTop: 54613 })).toBe('user'); // 2px is a user
    });

    it('anyone already reading history owns every scroll event → user', () => {
        // viewportY < baseY: a growth clamp that lands at max is still theirs
        // (xterm keeps them in history; we never yank them down).
        expect(classifyViewportScroll({
            viewportY: 2913, baseY: 2963, scrollTop: 43695, scrollHeight: 44479, clientHeight: 784,
        })).toBe('user');
        // …and scrolling back down toward the tail is also theirs.
        expect(classifyViewportScroll({
            viewportY: 2960, baseY: 2963, scrollTop: 44445, scrollHeight: 44479, clientHeight: 784,
        })).toBe('user');
    });

    it('tolerates fractional scrollTop within 1px of max (DPR ≠ 1)', () => {
        expect(SCROLL_MAX_TOLERANCE_PX).toBe(1);
        expect(classifyViewportScroll({ ...AT_TAIL, scrollTop: 54614.4 })).toBe('layout');
        expect(classifyViewportScroll({ ...AT_TAIL, scrollTop: 54613.9 })).toBe('user');
    });

    it('alternate buffer (no scroll range) classifies as layout, which is a no-op there', () => {
        // viewportY = baseY = 0, scrollHeight === clientHeight: scrollToBottom
        // has nothing to do; the guard must at least never call it "user" and
        // never throw on a zero range.
        expect(classifyViewportScroll({
            viewportY: 0, baseY: 0, scrollTop: 0, scrollHeight: 784, clientHeight: 784,
        })).toBe('layout');
    });
});

describe('createTailFollowGuard', () => {
    function setup(behind: () => boolean) {
        const scheduled: Array<() => void> = [];
        const pin = vi_fn();
        const guard = createTailFollowGuard({
            isBehindTail: behind,
            pin,
            schedule: (cb) => scheduled.push(cb),
        });
        return { guard, scheduled, pin };
    }
    function vi_fn() {
        const calls: number[] = [];
        const f = () => { calls.push(1); };
        f.calls = calls;
        return f;
    }
    const GROW_CLAMP: ViewportScrollSample = {
        viewportY: 3641, baseY: 3641, scrollTop: 54315, scrollHeight: 55399, clientHeight: 1084,
    };

    it('re-pins ONCE, after xterm handled the event, when xterm really drifted', () => {
        let behind = false;
        const { guard, scheduled, pin } = setup(() => behind);
        guard.onViewportScroll(GROW_CLAMP);
        // Not yet: xterm's own listener runs between the capture sample and the
        // scheduled callback — pinning now would be undone by it.
        expect(pin.calls).toHaveLength(0);
        expect(scheduled).toHaveLength(1);
        behind = true; // xterm's _handleScroll did its scrollLines(-20)
        scheduled[0]();
        expect(pin.calls).toHaveLength(1);
        expect(guard.counters.layoutRepins).toBe(1);
    });

    it('coalesces a burst of clamp events (keyboard animation frames) into one re-pin', () => {
        const { guard, scheduled, pin } = setup(() => true);
        guard.onViewportScroll(GROW_CLAMP);
        guard.onViewportScroll(GROW_CLAMP);
        guard.onViewportScroll(GROW_CLAMP);
        expect(scheduled).toHaveLength(1);
        scheduled[0]();
        expect(pin.calls).toHaveLength(1);
        // and arms again afterwards
        guard.onViewportScroll(GROW_CLAMP);
        expect(scheduled).toHaveLength(2);
    });

    it("xterm's own sync event (buffer still at tail when the callback runs) is not re-pinned", () => {
        const { guard, scheduled, pin } = setup(() => false);
        guard.onViewportScroll(GROW_CLAMP);
        scheduled[0]();
        expect(pin.calls).toHaveLength(0);
        expect(guard.counters.layoutRepins).toBe(0);
    });

    it('a user scrolling up from the tail is never pinned, and new output must not pull them back', () => {
        const { guard, scheduled, pin } = setup(() => true);
        guard.onViewportScroll({ ...AT_TAIL, scrollTop: 54465 }); // wheel up 10 rows
        expect(scheduled).toHaveLength(0);
        expect(guard.counters.userScrolls).toBe(1);
        // …then output arrives and the container grows while they read: theirs.
        guard.onViewportScroll({
            viewportY: 2913, baseY: 2963, scrollTop: 43395, scrollHeight: 44479, clientHeight: 1084,
        });
        expect(scheduled).toHaveLength(0);
        expect(pin.calls).toHaveLength(0);
    });

    it('does nothing after dispose, including an already scheduled re-pin', () => {
        const { guard, scheduled, pin } = setup(() => true);
        guard.onViewportScroll(GROW_CLAMP);
        guard.dispose();
        scheduled[0]();
        guard.onViewportScroll(GROW_CLAMP);
        expect(pin.calls).toHaveLength(0);
        expect(scheduled).toHaveLength(1);
    });
});

describe('isXtermViewport', () => {
    it('is false outside a DOM (no HTMLElement) and for null', () => {
        expect(isXtermViewport(null)).toBe(false);
        expect(isXtermViewport({} as EventTarget)).toBe(false);
    });
});

/**
 * Wiring guards. The screen has no jsdom harness (see termChannelV2.test.ts),
 * so the three entry paths — mount (new / from the list), tab return
 * (catch-up), daemon restart (snapshot) — are pinned at the source level:
 * every one of them ends in the reveal gate or a restore write, and every one
 * shares the ONE capture-phase guard. Each assertion names a line whose silent
 * disappearance has a measured failure (mutation-checked, see the T-009 board
 * status).
 */
describe('WebTerminalScreen wiring (T-009)', () => {
    const screen = readFileSync(fileURLToPath(new URL('./WebTerminalScreen.tsx', import.meta.url)), 'utf8');

    it('the first visible frame is pinned to the last line AFTER the drain, before the reveal', () => {
        // Order matters: scrollToBottom must precede setReadySurfaceKey inside
        // onReveal, and onReveal only runs from the drained write barrier.
        expect(screen).toMatch(/onReveal: \(\) => \{\s*term\.scrollToBottom\(\);\s*setReadySurfaceKey\(surfaceKey\);/);
    });

    it('the guard samples in CAPTURE phase on the mount, before xterm sees the event', () => {
        expect(screen).toContain("mount.addEventListener('scroll', onViewportScrollCapture, { capture: true, passive: true })");
        expect(screen).toContain('if (disposed || !isXtermViewport(ev.target)) return;');
    });

    it('re-pins through scrollToBottom only when xterm actually fell behind the tail', () => {
        expect(screen).toContain('isBehindTail: () => term.buffer.active.viewportY < term.buffer.active.baseY,');
        expect(screen).toContain('pin: () => term.scrollToBottom(),');
        expect(screen).toContain('schedule: (cb) => { requestAnimationFrame(cb); },');
    });

    it('the deep-history rebuild pins after its pages are PARSED, not when they were queued', () => {
        expect(screen).toContain("term.write('', () => { if (!disposed) term.scrollToBottom(); });");
    });

    it('the guard is torn down with the mount', () => {
        expect(screen).toContain('tailGuard.dispose();');
        expect(screen).toContain("mount.removeEventListener('scroll', onViewportScrollCapture, { capture: true } as EventListenerOptions);");
    });
});
