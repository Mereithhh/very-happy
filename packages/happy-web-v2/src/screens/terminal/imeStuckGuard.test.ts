/**
 * Unit tests for the desktop IME stuck-composition guard (round 2).
 *
 * Regression anchors:
 *  - 2026-08-12 round 1: a macOS input-source switch mid-composition aborts
 *    the composition WITHOUT compositionend → xterm's CompositionHelper keeps
 *    _isComposing=true → 229 keys swallowed, the next English key commits the
 *    aborted preedit as a stray letter, bubble stuck at the cursor.
 *  - 2026-08-12 round 2 (real-order CDP replay): the guard must NEVER touch a
 *    live composition — the 229 path requires a SUSTAINED contradiction (any
 *    composition event resets it), and healing/clearing must never write the
 *    textarea while an IME could be attached (a programmatic write under an
 *    active composition cancels it EVENTLESSLY, manufacturing the stuck
 *    state). Residue clearing is blur-scoped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createCompositionSettleClear,
    createStuckDetector,
    shouldHealStuckComposition,
} from './imeStuckGuard';

describe('shouldHealStuckComposition', () => {
    it('contradiction when helper says composing but the event says not (eventless abort)', () => {
        // English key pressed while stuck
        expect(shouldHealStuckComposition(true, { isComposing: false })).toBe(true);
        // the swallowed-Chinese case: Chrome delivers key='Process'/229 with
        // isComposing=false — 'Process' must NOT be read as "composing" here,
        // or the healer skips exactly the state users are stuck in
        expect(shouldHealStuckComposition(true, { key: 'Process', isComposing: false } as any)).toBe(true);
    });

    it('never contradicts during a REAL composition (isComposing is the browser truth)', () => {
        expect(shouldHealStuckComposition(true, { isComposing: true })).toBe(false);
    });

    it('never contradicts on events that omit the property (legacy browsers)', () => {
        expect(shouldHealStuckComposition(true, {})).toBe(false);
        expect(shouldHealStuckComposition(true, { isComposing: undefined })).toBe(false);
    });

    it('no-op when the helper is not composing (normal typing path)', () => {
        expect(shouldHealStuckComposition(false, { isComposing: false })).toBe(false);
        expect(shouldHealStuckComposition(false, { isComposing: true })).toBe(false);
    });
});

describe('createStuckDetector', () => {
    it('composition-opening keydown never heals (helper flag still false there)', () => {
        // Real order (MDN keydown_event / UI Events): the keydown that OPENS a
        // composition is 229 + isComposing=false, and compositionstart — which
        // raises the helper flag — only fires after it.
        const d = createStuckDetector();
        expect(d.keydown(false, { keyCode: 229, isComposing: false })).toBe(false);
    });

    it('non-229 contradictory keydown heals IMMEDIATELY (beats finalize(false) stray commit)', () => {
        const d = createStuckDetector();
        expect(d.keydown(true, { keyCode: 65, isComposing: false })).toBe(true);
    });

    it('229 contradictory keydown needs a sustained streak (2+)', () => {
        const d = createStuckDetector();
        expect(d.keydown(true, { keyCode: 229, isComposing: false })).toBe(false);
        expect(d.keydown(true, { keyCode: 229, isComposing: false })).toBe(true);
    });

    it('bare modifiers count like 229 (xterm swallows them without finalizing)', () => {
        const d = createStuckDetector();
        expect(d.keydown(true, { keyCode: 16, isComposing: false })).toBe(false);
        expect(d.keydown(true, { keyCode: 17, isComposing: false })).toBe(true);
    });

    it('any composition event resets the streak — a live (even mis-reporting) IME is never healed into', () => {
        const d = createStuckDetector();
        expect(d.keydown(true, { keyCode: 229, isComposing: false })).toBe(false);
        d.compositionEvent(); // e.g. compositionupdate from the live composition
        expect(d.keydown(true, { keyCode: 229, isComposing: false })).toBe(false);
        d.compositionEvent();
        expect(d.keydown(true, { keyCode: 229, isComposing: false })).toBe(false);
    });

    it('a non-contradictory keydown resets the streak', () => {
        const d = createStuckDetector();
        expect(d.keydown(true, { keyCode: 229, isComposing: false })).toBe(false);
        expect(d.keydown(true, { keyCode: 229, isComposing: true })).toBe(false); // real composition signal
        expect(d.keydown(true, { keyCode: 229, isComposing: false })).toBe(false); // streak restarted at 1
        expect(d.keydown(true, { keyCode: 229, isComposing: false })).toBe(true);
    });

    it('stuck 你-recovery sequence: keydown → compositionstart resets → never heals on the 229 path', () => {
        // Replay scenario D: first Chinese key after the abort starts a NEW
        // composition; its compositionstart re-syncs xterm on its own.
        const d = createStuckDetector();
        expect(d.keydown(true, { keyCode: 229, isComposing: false })).toBe(false); // key 1
        d.compositionEvent(); // compositionstart of the fresh composition
        expect(d.keydown(true, { keyCode: 229, isComposing: true })).toBe(false); // key 2, live
    });
});

describe('createCompositionSettleClear', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const make = (flags: { composing: boolean; sending: boolean }) => {
        const clear = vi.fn();
        const settle = createCompositionSettleClear({ read: () => ({ ...flags }), clear });
        return { flags, clear, settle };
    };

    it('clears once the helper has settled', () => {
        const { clear, settle } = make({ composing: false, sending: false });
        settle.arm();
        expect(clear).not.toHaveBeenCalled(); // deferred — finalize reads async
        vi.advanceTimersByTime(50);
        expect(clear).toHaveBeenCalledTimes(1);
    });

    it("waits while finalize's deferred read is still pending, then clears", () => {
        const { flags, clear, settle } = make({ composing: false, sending: true });
        settle.arm();
        vi.advanceTimersByTime(50);
        expect(clear).not.toHaveBeenCalled(); // sending → retry, don't eat the commit
        flags.sending = false;
        vi.advanceTimersByTime(50);
        expect(clear).toHaveBeenCalledTimes(1);
    });

    it('gives up (bounded) if the helper never settles', () => {
        const { clear, settle } = make({ composing: false, sending: true });
        settle.arm();
        vi.advanceTimersByTime(50 * 20);
        expect(clear).not.toHaveBeenCalled();
    });

    it('aborts when a composition is live (never clear under an IME)', () => {
        const { flags, clear, settle } = make({ composing: true, sending: false });
        settle.arm();
        vi.advanceTimersByTime(500);
        expect(clear).not.toHaveBeenCalled();
        // field left the IME's hands again (next blur) → re-arm → clears
        flags.composing = false;
        settle.arm();
        vi.advanceTimersByTime(50);
        expect(clear).toHaveBeenCalledTimes(1);
    });

    it('cancelPending (keydown / focusin) suppresses a scheduled clear', () => {
        const { clear, settle } = make({ composing: false, sending: false });
        settle.arm();
        settle.cancelPending(); // user is back — never mutate the field under them
        vi.advanceTimersByTime(1000);
        expect(clear).not.toHaveBeenCalled();
        // re-armed by the next blur → clears in the quiet window
        settle.arm();
        vi.advanceTimersByTime(50);
        expect(clear).toHaveBeenCalledTimes(1);
    });

    it('re-arming restarts the timer instead of stacking clears', () => {
        const { clear, settle } = make({ composing: false, sending: false });
        settle.arm();
        vi.advanceTimersByTime(30);
        settle.arm();
        vi.advanceTimersByTime(30);
        expect(clear).not.toHaveBeenCalled(); // restarted, not expired
        vi.advanceTimersByTime(20);
        expect(clear).toHaveBeenCalledTimes(1);
    });
});
