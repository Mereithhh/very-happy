import { describe, expect, it } from 'vitest';
import { CLIPBOARD_MAX_BYTES, prepareClipboardText } from './limits';

describe('prepareClipboardText', () => {
    it('passes small text through untouched', () => {
        const r = prepareClipboardText('hello clipboard');
        expect(r.text).toBe('hello clipboard');
        expect(r.truncated).toBe(false);
        expect(r.totalBytes).toBe(Buffer.byteLength('hello clipboard'));
    });

    it('passes text exactly at the limit', () => {
        const input = 'a'.repeat(CLIPBOARD_MAX_BYTES);
        const r = prepareClipboardText(input);
        expect(r.truncated).toBe(false);
        expect(r.text.length).toBe(CLIPBOARD_MAX_BYTES);
    });

    it('truncates ASCII text over the limit to exactly the cap', () => {
        const input = 'a'.repeat(CLIPBOARD_MAX_BYTES + 1000);
        const r = prepareClipboardText(input);
        expect(r.truncated).toBe(true);
        expect(r.totalBytes).toBe(CLIPBOARD_MAX_BYTES + 1000);
        expect(Buffer.byteLength(r.text, 'utf8')).toBe(CLIPBOARD_MAX_BYTES);
    });

    it('never splits a multi-byte character at the cut point', () => {
        // '中' is 3 bytes in UTF-8; MAX is a multiple of 1024 so the boundary
        // always lands mid-character for an all-CJK payload.
        const input = '中'.repeat(Math.ceil((CLIPBOARD_MAX_BYTES + 30) / 3));
        const r = prepareClipboardText(input);
        expect(r.truncated).toBe(true);
        expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(CLIPBOARD_MAX_BYTES);
        expect(r.text.includes('�')).toBe(false);
        // Round-trips cleanly (no broken tail sequence)
        expect(Buffer.from(r.text, 'utf8').toString('utf8')).toBe(r.text);
    });

    it('never leaves a lone surrogate at the cut point', () => {
        // '😀' is 4 UTF-8 bytes / a surrogate pair in UTF-16. The 2-byte prefix
        // forces the byte cap to land mid-emoji.
        const input = 'ab' + '😀'.repeat(Math.ceil((CLIPBOARD_MAX_BYTES + 30) / 4));
        const r = prepareClipboardText(input);
        expect(r.truncated).toBe(true);
        const last = r.text.charCodeAt(r.text.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
        expect(r.text.includes('�')).toBe(false);
    });
});
