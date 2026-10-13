// @vitest-environment happy-dom
/**
 * B-592: an auto-copy push that cannot be written right now (page in the
 * background, or the browser wants a gesture) waits and lands by itself on
 * the next focus / gesture — the user never has to click a toast.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toasts = vi.hoisted(() => ({ success: vi.fn(), action: vi.fn(), error: vi.fn() }));
vi.mock('@/ui/Toast', () => ({ toast: toasts }));
const settings = vi.hoisted(() => ({ clipboardAutoCopy: true }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ localSettings: settings, sessions: {}, machines: {} }) } }));

import { deliverToClipboard, isClipboardGestureKey, resetClipboardDeliveryForTest } from './clipboardPush';

let focused = true;
let visibility: 'visible' | 'hidden' = 'visible';
const writeText = vi.fn(async (_text: string) => {});

beforeEach(() => {
    vi.clearAllMocks();
    settings.clipboardAutoCopy = true;
    focused = true; visibility = 'visible';
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    writeText.mockImplementation(async () => {});
});
afterEach(() => resetClipboardDeliveryForTest());

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('clipboard push delivery (B-592)', () => {
    it('focused page: written at once, no tap-to-copy toast', async () => {
        await deliverToClipboard('hello');
        expect(writeText).toHaveBeenCalledWith('hello');
        expect(toasts.success).toHaveBeenCalledTimes(1);
        expect(toasts.action).not.toHaveBeenCalled();
    });

    it('background page: nothing asked of the user; written when the page regains focus', async () => {
        focused = false; visibility = 'hidden';
        await deliverToClipboard('later');
        expect(writeText).not.toHaveBeenCalled();
        expect(toasts.action).not.toHaveBeenCalled();
        focused = true; visibility = 'visible';
        window.dispatchEvent(new Event('focus'));
        await flush();
        expect(writeText).toHaveBeenCalledWith('later');
        expect(toasts.success).toHaveBeenCalledTimes(1);
        // delivered once: later focus events do not write again
        window.dispatchEvent(new Event('focus'));
        await flush();
        expect(writeText).toHaveBeenCalledTimes(1);
    });

    it('newest waiting push wins', async () => {
        focused = false;
        await deliverToClipboard('first');
        await deliverToClipboard('second');
        focused = true;
        window.dispatchEvent(new Event('focus'));
        await flush();
        expect(writeText.mock.calls.map((c) => c[0])).toEqual(['second']);
    });

    it('gesture-only browsers: a rejected write waits for the next pointer/key gesture', async () => {
        writeText.mockRejectedValueOnce(new Error('NotAllowedError'));
        await deliverToClipboard('gesture');
        expect(toasts.action).not.toHaveBeenCalled();
        window.dispatchEvent(new Event('pointerdown'));
        await flush();
        expect(writeText).toHaveBeenLastCalledWith('gesture');
        expect(toasts.success).toHaveBeenCalledTimes(1);
    });

    it('a gesture write that still fails falls back to the clickable toast', async () => {
        writeText.mockRejectedValue(new Error('NotAllowedError'));
        await deliverToClipboard('blocked');
        window.dispatchEvent(new Event('keydown'));
        await flush();
        expect(toasts.action).toHaveBeenCalledTimes(1);
    });

    it('the ⌘ of ⌘V / ⌘C is not the write gesture: the user\'s clipboard is left alone', async () => {
        // Repro (headed Chromium, real macOS pasteboard): a waiting push was
        // written on the Meta keydown of ⌘V, racing the paste — the push
        // replaced what was pasted and the user's clipboard every time.
        writeText.mockRejectedValueOnce(new Error('NotAllowedError'));
        await deliverToClipboard('pushed');
        writeText.mockClear();
        for (const init of [
            { key: 'Meta', metaKey: true },
            { key: 'v', metaKey: true },
            { key: 'c', metaKey: true },
            { key: 'Control', ctrlKey: true },
            { key: 'v', ctrlKey: true },
            { key: 'Shift', shiftKey: true },
        ]) window.dispatchEvent(new KeyboardEvent('keydown', init));
        await flush();
        expect(writeText).not.toHaveBeenCalled();
        // still waiting: plain typing (or a click) is the gesture
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
        await flush();
        expect(writeText).toHaveBeenCalledWith('pushed');
    });

    it('isClipboardGestureKey: plain keys yes, chords and bare modifiers no', () => {
        expect(isClipboardGestureKey({ key: 'a' })).toBe(true);
        expect(isClipboardGestureKey({ key: 'Enter' })).toBe(true);
        expect(isClipboardGestureKey({ key: 'v', metaKey: true })).toBe(false);
        expect(isClipboardGestureKey({ key: 'v', ctrlKey: true })).toBe(false);
        expect(isClipboardGestureKey({ key: 'Meta' })).toBe(false);
        expect(isClipboardGestureKey({ key: 'Alt' })).toBe(false);
    });

    it('auto-copy off keeps the explicit tap-to-copy toast', async () => {
        settings.clipboardAutoCopy = false;
        await deliverToClipboard('manual');
        expect(writeText).not.toHaveBeenCalled();
        expect(toasts.action).toHaveBeenCalledTimes(1);
    });
});
