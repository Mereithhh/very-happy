/**
 * Unit tests for the desktop IME stuck-composition guard (round 2).
 *
 * Regression anchors:
 *  - 2026-08-12 round 1: a macOS input-source switch mid-composition aborts
 *    the composition WITHOUT compositionend → xterm's CompositionHelper keeps
 *    _isComposing=true → 229 keys swallowed, the next English key commits the
 *    aborted preedit as a stray letter, bubble stuck at the cursor.
 *  - 2026-08-12 round 2 (real-order CDP replay): the guard must NEVER touch a
 *    live composition, and healing/clearing must never write the textarea while
 *    an IME could be attached (a programmatic write under an active composition
 *    cancels it EVENTLESSLY, manufacturing the stuck state). Residue clearing
 *    is blur-scoped.
 *  - 2026-08-14 round 3: round-2's "sustained contradiction" 229 branch was
 *    measured to be DEAD CODE and is retired (229/modifiers never heal); the
 *    non-229 immediate heal stays. Plus the focus-only composition flag — the
 *    guard against "moving focus eats in-flight preedit text".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createCompositionFocusFlag,
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

    // ── round-3 regression anchor (2026-08-14) ───────────────────────────
    // The round-2 "sustained contradiction (streak >= 2)" branch was measured
    // to be UNREACHABLE: the compositionstart that follows key 1 reset the
    // streak, and keys 2..n of a real composition report isComposing:true, so
    // no second contradictory keydown ever arrived. It is retired: 229 and bare
    // modifiers now never heal (xterm swallows them without finalizing, so
    // nothing can be corrupted), and the non-229 branch — the one measurement
    // showed working — is untouched.
    it('229 contradictory keydowns NEVER heal (retired dead branch, no streak)', () => {
        const d = createStuckDetector();
        for (let i = 0; i < 5; i++) {
            expect(d.keydown(true, { keyCode: 229, isComposing: false })).toBe(false);
        }
    });

    it('bare modifiers never heal either (xterm swallows them without finalizing)', () => {
        const d = createStuckDetector();
        expect(d.keydown(true, { keyCode: 16, isComposing: false })).toBe(false);
        expect(d.keydown(true, { keyCode: 17, isComposing: false })).toBe(false);
        expect(d.keydown(true, { keyCode: 18, isComposing: false })).toBe(false);
    });

    it('the detector is stateless: a 229 run never arms a later heal', () => {
        const d = createStuckDetector();
        d.keydown(true, { keyCode: 229, isComposing: false });
        d.keydown(true, { keyCode: 229, isComposing: false });
        // ...and a genuinely dangerous key still heals immediately.
        expect(d.keydown(true, { keyCode: 66, isComposing: false })).toBe(true);
    });

    it('keys with no keyCode are treated as 229 (never healed)', () => {
        const d = createStuckDetector();
        expect(d.keydown(true, { isComposing: false })).toBe(false);
    });

    it('a live composition is never healed into, whatever the key', () => {
        const d = createStuckDetector();
        expect(d.keydown(true, { keyCode: 65, isComposing: true })).toBe(false);
        expect(d.keydown(true, { keyCode: 229, isComposing: true })).toBe(false);
    });
});

describe('createCompositionFocusFlag (focus decisions ONLY)', () => {
    // Regression anchor (2026-08-14): refocus()'s `ta.blur()` fired while a
    // composition was in flight → xterm emitted ZERO onData → the pinyin the
    // user had already typed vanished ("切输入法就打不了中文"). Nothing may move
    // focus while this flag is true. It must NEVER gate sending text.
    const mk = (staleMs = 5000) => {
        let t = 1000;
        const flag = createCompositionFocusFlag({ now: () => t, staleMs });
        return { flag, tick: (ms: number) => { t += ms; }, at: () => t };
    };

    it('false before anything happens', () => {
        expect(mk().flag.composing()).toBe(false);
    });

    it('compositionstart → true, compositionend → false', () => {
        const { flag } = mk();
        flag.start();
        expect(flag.composing()).toBe(true);
        flag.end();
        expect(flag.composing()).toBe(false);
    });

    it('compositionupdate keeps a long pinyin composition alive past the stale window', () => {
        const { flag, tick } = mk(5000);
        flag.start();
        for (let i = 0; i < 4; i++) { tick(4000); flag.update(); }
        expect(flag.composing()).toBe(true);
    });

    it('an EVENT-LESS abort expires instead of freezing focus forever', () => {
        // The round-1/2 failure: composition dies with no compositionend. A
        // sticky true would disable the focus watchdog for the whole session.
        const { flag, tick } = mk(5000);
        flag.start();
        tick(5000);
        expect(flag.composing()).toBe(false);
        // and it stays false without any further event
        expect(flag.composing()).toBe(false);
    });

    it('update() on an already-expired flag does not resurrect it', () => {
        const { flag, tick } = mk(5000);
        flag.start();
        tick(6000);
        expect(flag.composing()).toBe(false);
        flag.update();
        expect(flag.composing()).toBe(false);
    });

    it('clear() (blur / browser-says-not-composing) drops it immediately', () => {
        const { flag } = mk();
        flag.start();
        flag.clear();
        expect(flag.composing()).toBe(false);
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
