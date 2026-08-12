/**
 * Unit tests for the desktop IME stuck-composition guard.
 *
 * Regression anchor (2026-08-12 user reports, reproduced in a real-browser
 * harness): a macOS input-source switch mid-composition aborts the composition
 * WITHOUT compositionend → xterm's CompositionHelper keeps _isComposing=true →
 * every keyCode-229 keydown (all CJK IME keys) is swallowed ("只能英文输入"),
 * the next English key commits the aborted preedit as a stray letter, and the
 * composition-view bubble stays visible at the cursor ("一个字母删不掉").
 * blur+refocus does NOT clear the flag (no browser composition → no
 * compositionend on blur), so only keydown-time detection can heal it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createCompositionSettleClear,
    shouldHealStuckComposition,
} from './imeStuckGuard';

describe('shouldHealStuckComposition', () => {
    it('heals when helper says composing but the event says not (eventless abort)', () => {
        // English key pressed while stuck
        expect(shouldHealStuckComposition(true, { isComposing: false })).toBe(true);
        // the swallowed-Chinese case: Chrome delivers key='Process'/229 with
        // isComposing=false — 'Process' must NOT be read as "composing" here,
        // or the healer skips exactly the state users are stuck in
        expect(shouldHealStuckComposition(true, { key: 'Process', isComposing: false } as any)).toBe(true);
    });

    it('never heals during a REAL composition (isComposing is the browser truth)', () => {
        expect(shouldHealStuckComposition(true, { isComposing: true })).toBe(false);
    });

    it('never heals on events that omit the property (legacy browsers)', () => {
        expect(shouldHealStuckComposition(true, {})).toBe(false);
        expect(shouldHealStuckComposition(true, { isComposing: undefined })).toBe(false);
    });

    it('no-op when the helper is not composing (normal typing path)', () => {
        expect(shouldHealStuckComposition(false, { isComposing: false })).toBe(false);
        expect(shouldHealStuckComposition(false, { isComposing: true })).toBe(false);
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

    it('aborts when a new composition takes over (its compositionend re-arms)', () => {
        const { flags, clear, settle } = make({ composing: true, sending: false });
        settle.arm();
        vi.advanceTimersByTime(500);
        expect(clear).not.toHaveBeenCalled();
        // the next composition ends → re-arm → clears
        flags.composing = false;
        settle.arm();
        vi.advanceTimersByTime(50);
        expect(clear).toHaveBeenCalledTimes(1);
    });

    it('cancelPending (any keydown) suppresses a scheduled clear', () => {
        const { clear, settle } = make({ composing: false, sending: false });
        settle.arm();
        settle.cancelPending(); // user typed — never mutate the field under them
        vi.advanceTimersByTime(1000);
        expect(clear).not.toHaveBeenCalled();
        // re-armed by the next compositionend → clears in the quiet window
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
