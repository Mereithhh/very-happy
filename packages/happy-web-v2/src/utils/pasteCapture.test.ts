// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { installPasteCapture, pastedPlainText, resetPasteCaptureForTest } from './pasteCapture';

afterEach(() => resetPasteCaptureForTest());

function pasteWith(getData: () => string) {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    const data = { getData: (type: string) => (type === 'text/plain' ? getData() : '') };
    Object.defineProperty(event, 'clipboardData', { value: data });
    return { event, data };
}

describe('pasteCapture', () => {
    it('keeps the text read at window capture after the pasteboard is swapped back', () => {
        const target = new EventTarget();
        installPasteCapture(target as unknown as Window);
        let board = 'second dictation';
        const { event, data } = pasteWith(() => board);
        target.dispatchEvent(event);
        board = ''; // Wispr restores the old pasteboard before the composer reads it
        expect(data.getData('text/plain')).toBe('');
        expect(pastedPlainText(event, data)).toBe('second dictation');
    });

    it('falls back to a late read when no snapshot exists, and null when there is no text', () => {
        const { event, data } = pasteWith(() => 'typed');
        expect(pastedPlainText(event, data)).toBe('typed');
        const empty = pasteWith(() => '');
        expect(pastedPlainText(empty.event, empty.data)).toBeNull();
    });
});
