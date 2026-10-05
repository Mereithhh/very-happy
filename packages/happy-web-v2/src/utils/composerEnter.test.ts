// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECENT_COMPOSITION_MS, isImeGuardedEvent, markCompositionEnd } from '@/utils/ime';
import { insertComposerNewline, isSoftKeyboardDevice, resolveComposerEnter, type ComposerKeyLike } from './composerEnter';

const T0 = 1_700_000_000_000;

/** Same wiring as the composers: guarded = the real IME guard's verdict. */
function press(e: ComposerKeyLike & { isComposing?: boolean }, opts: { enterToSend?: boolean; softKeyboard?: boolean } = {}) {
    return resolveComposerEnter(e, {
        guarded: isImeGuardedEvent(e),
        enterToSend: opts.enterToSend ?? true,
        softKeyboard: opts.softKeyboard ?? false,
    });
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    markCompositionEnd(T0 - 60_000);
});
afterEach(() => vi.useRealTimers());

describe('desktop, Enter-to-send (default)', () => {
    it('Enter sends; Cmd/Ctrl/Alt+Enter insert a newline; Shift+Enter is the native newline', () => {
        expect(press({ key: 'Enter' })).toBe('send');
        expect(press({ key: 'Enter', metaKey: true })).toBe('newline');
        expect(press({ key: 'Enter', ctrlKey: true })).toBe('newline');
        expect(press({ key: 'Enter', altKey: true })).toBe('newline');
        expect(press({ key: 'Enter', shiftKey: true })).toBe('native');
        expect(press({ key: 'a' })).toBe('native');
    });
});

describe('desktop, Enter-to-send off', () => {
    it('Enter is a newline, only Cmd/Ctrl+Enter sends', () => {
        const off = { enterToSend: false };
        expect(press({ key: 'Enter' }, off)).toBe('native');
        expect(press({ key: 'Enter', shiftKey: true }, off)).toBe('native');
        expect(press({ key: 'Enter', metaKey: true }, off)).toBe('send');
        expect(press({ key: 'Enter', ctrlKey: true }, off)).toBe('send');
    });
});

describe('soft keyboard (touch-first device)', () => {
    it('Return always inserts a newline natively regardless of the setting', () => {
        for (const enterToSend of [true, false]) {
            expect(press({ key: 'Enter' }, { enterToSend, softKeyboard: true })).toBe('native');
            expect(press({ key: 'Enter', shiftKey: true }, { enterToSend, softKeyboard: true })).toBe('native');
        }
    });

    it('a tablet hardware keyboard can still send with Cmd/Ctrl+Enter', () => {
        expect(press({ key: 'Enter', metaKey: true }, { softKeyboard: true })).toBe('send');
        expect(press({ key: 'Enter', ctrlKey: true }, { softKeyboard: true })).toBe('send');
    });

    it("Android keyboards' 'Unidentified' Enter is left to the textarea", () => {
        expect(press({ key: 'Unidentified' }, { softKeyboard: true })).toBe('native');
    });
});

describe('CJK IME never sends or inserts', () => {
    it.each([
        ['isComposing', { key: 'Enter', isComposing: true }],
        ["Chrome 'Process'", { key: 'Process' }],
        ['Cmd+Enter while composing', { key: 'Enter', metaKey: true, isComposing: true }],
    ])('%s', (_label, e) => {
        expect(press(e)).toBe('native');
        expect(press(e, { enterToSend: false })).toBe('native');
        expect(press(e, { softKeyboard: true })).toBe('native');
    });

    it("Safari's committing Enter right after compositionend is ignored, a later Enter sends", () => {
        markCompositionEnd(T0);
        vi.setSystemTime(T0 + RECENT_COMPOSITION_MS - 1);
        expect(press({ key: 'Enter' })).toBe('native');
        vi.setSystemTime(T0 + RECENT_COMPOSITION_MS);
        expect(press({ key: 'Enter' })).toBe('send');
    });
});

describe('isSoftKeyboardDevice', () => {
    it('follows the (hover: none) and (pointer: coarse) media query', () => {
        const original = window.matchMedia;
        try {
            window.matchMedia = ((q: string) => ({ matches: q === '(hover: none) and (pointer: coarse)' })) as typeof window.matchMedia;
            expect(isSoftKeyboardDevice()).toBe(true);
            window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia;
            expect(isSoftKeyboardDevice()).toBe(false);
        } finally {
            window.matchMedia = original;
        }
    });
});

describe('insertComposerNewline', () => {
    it('replaces the selection with a newline, keeps the caret after it, and fires input', () => {
        const ta = document.createElement('textarea');
        document.body.appendChild(ta);
        ta.value = 'helloXworld';
        ta.setSelectionRange(5, 6);
        const onInput = vi.fn();
        ta.addEventListener('input', onInput);
        insertComposerNewline(ta);
        expect(ta.value).toBe('hello\nworld');
        expect(ta.selectionStart).toBe(6);
        expect(onInput).toHaveBeenCalledOnce();
        ta.remove();
    });
});
