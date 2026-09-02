import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECENT_COMPOSITION_MS, isImeGuardedEvent, markCompositionEnd } from '@/utils/ime';
import { resolveBtwComposerKey } from './btwSubmitKey';

const T0 = 1_700_000_000_000;

/** Same wiring as the panel: guarded = the real IME guard's verdict on the event. */
function press(e: { key: string; shiftKey?: boolean; isComposing?: boolean }, enterToSend = true) {
    return resolveBtwComposerKey({
        key: e.key,
        shiftKey: e.shiftKey ?? false,
        guarded: isImeGuardedEvent(e),
        enterToSend,
    });
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    markCompositionEnd(T0 - 60_000);
});
afterEach(() => vi.useRealTimers());

describe('side-question composer keys vs CJK IME (B-279)', () => {
    it('plain Enter submits, Shift+Enter is a newline, other keys are ignored', () => {
        expect(press({ key: 'Enter' })).toBe('submit');
        expect(press({ key: 'Enter', shiftKey: true })).toBe('newline');
        expect(press({ key: 'a' })).toBe('ignore');
    });

    it('Enter that confirms an IME candidate never submits (isComposing)', () => {
        expect(press({ key: 'Enter', isComposing: true })).toBe('ignore');
    });

    it("Chrome's IME-swallowed key ('Process') never submits", () => {
        expect(press({ key: 'Process' })).toBe('ignore');
    });

    it("Safari's committing Enter right after compositionend never submits, a later Enter does", () => {
        markCompositionEnd(T0);
        vi.setSystemTime(T0 + RECENT_COMPOSITION_MS - 1);
        expect(press({ key: 'Enter' })).toBe('ignore');
        vi.setSystemTime(T0 + RECENT_COMPOSITION_MS);
        expect(press({ key: 'Enter' })).toBe('submit');
    });

    it('honours "Enter inserts a newline" (agentInputEnterToSend=false): Shift+Enter sends', () => {
        expect(press({ key: 'Enter' }, false)).toBe('newline');
        expect(press({ key: 'Enter', shiftKey: true }, false)).toBe('submit');
        expect(press({ key: 'Enter', shiftKey: true, isComposing: true }, false)).toBe('ignore');
    });
});
