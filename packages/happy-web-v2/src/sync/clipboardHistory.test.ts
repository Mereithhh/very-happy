import { describe, it, expect } from 'vitest';
import {
    appendClipboardEntry,
    removeClipboardEntry,
    updateClipboardEntryText,
    clipboardPreview,
    isClipboardHistoryEntry,
    truncateForHistory,
    CLIPBOARD_HISTORY_CAP,
    CLIPBOARD_HISTORY_TEXT_CHARS,
    type ClipboardHistoryEntry,
} from './clipboardHistory';

function entry(id: string, text: string, createdAt = 0): ClipboardHistoryEntry {
    return { id, text, createdAt };
}

describe('appendClipboardEntry', () => {
    it('prepends newest first', () => {
        const a = entry('a', 'aaa', 1);
        const b = entry('b', 'bbb', 2);
        const out = appendClipboardEntry([a], b);
        expect(out.map((e) => e.id)).toEqual(['b', 'a']);
    });

    it('dedupes identical text: re-push moves to top instead of duplicating', () => {
        const a = entry('a', 'same', 1);
        const b = entry('b', 'other', 2);
        const c = entry('c', 'same', 3);
        const out = appendClipboardEntry([b, a], c);
        expect(out.map((e) => e.id)).toEqual(['c', 'b']);
        expect(out[0].createdAt).toBe(3);
    });

    it('trims to the cap, dropping the oldest', () => {
        const many = Array.from({ length: CLIPBOARD_HISTORY_CAP }, (_, i) =>
            entry(`e${i}`, `text-${i}`, i),
        );
        const fresh = entry('new', 'newest', 999);
        const out = appendClipboardEntry(many, fresh);
        expect(out).toHaveLength(CLIPBOARD_HISTORY_CAP);
        expect(out[0].id).toBe('new');
        // oldest (last) original entry fell off
        expect(out.some((e) => e.id === `e${CLIPBOARD_HISTORY_CAP - 1}`)).toBe(false);
    });

    it('respects a custom cap and never returns an empty list for cap<1', () => {
        const out = appendClipboardEntry([entry('a', 'aaa')], entry('b', 'bbb'), 0);
        expect(out.map((e) => e.id)).toEqual(['b']);
    });

    it('does not mutate the input array', () => {
        const input = [entry('a', 'aaa')];
        const snapshot = [...input];
        appendClipboardEntry(input, entry('b', 'bbb'));
        expect(input).toEqual(snapshot);
    });
});

describe('removeClipboardEntry', () => {
    it('removes by id', () => {
        const out = removeClipboardEntry([entry('a', 'aaa'), entry('b', 'bbb')], 'a');
        expect(out.map((e) => e.id)).toEqual(['b']);
    });

    it('returns the same array reference when the id is absent', () => {
        const input = [entry('a', 'aaa')];
        expect(removeClipboardEntry(input, 'zz')).toBe(input);
    });
});

describe('updateClipboardEntryText', () => {
    it('replaces the text of the matching entry only', () => {
        const out = updateClipboardEntryText(
            [entry('a', 'aaa'), entry('b', 'bbb')],
            'a',
            'edited',
        );
        expect(out.find((e) => e.id === 'a')?.text).toBe('edited');
        expect(out.find((e) => e.id === 'b')?.text).toBe('bbb');
    });

    it('is a no-op (same reference) when id is absent or text unchanged', () => {
        const input = [entry('a', 'aaa')];
        expect(updateClipboardEntryText(input, 'zz', 'x')).toBe(input);
        expect(updateClipboardEntryText(input, 'a', 'aaa')).toBe(input);
    });
});

describe('clipboardPreview', () => {
    it('collapses whitespace and trims', () => {
        expect(clipboardPreview('  foo\n\n  bar\tbaz  ')).toBe('foo bar baz');
    });

    it('returns short text as-is', () => {
        expect(clipboardPreview('short', 10)).toBe('short');
    });

    it('truncates to max chars with an ellipsis', () => {
        const out = clipboardPreview('abcdefghij', 8);
        expect(out.length).toBeLessThanOrEqual(8);
        expect(out.endsWith('…')).toBe(true);
        expect(out.startsWith('abcdef')).toBe(true);
    });

    it('does not leave a trailing space before the ellipsis', () => {
        expect(clipboardPreview('abcdef ghijkl', 8)).toBe('abcdef…');
    });
});

describe('truncateForHistory', () => {
    it('returns short text unchanged (same reference)', () => {
        const s = 'hello';
        expect(truncateForHistory(s)).toBe(s);
    });

    it('caps oversized payloads at the history limit', () => {
        const big = 'x'.repeat(CLIPBOARD_HISTORY_TEXT_CHARS + 100);
        expect(truncateForHistory(big)).toHaveLength(CLIPBOARD_HISTORY_TEXT_CHARS);
    });

    it('honors a custom max', () => {
        expect(truncateForHistory('abcdef', 3)).toBe('abc');
    });
});

describe('isClipboardHistoryEntry', () => {
    it('accepts a minimal valid entry', () => {
        expect(isClipboardHistoryEntry({ id: 'x', text: 't', createdAt: 1 })).toBe(true);
    });

    it('accepts optional source fields', () => {
        expect(
            isClipboardHistoryEntry({
                id: 'x', text: 't', createdAt: 1,
                sourceType: 'session', sourceId: 's1', sourceLabel: 'My chat',
            }),
        ).toBe(true);
    });

    it('rejects malformed values', () => {
        expect(isClipboardHistoryEntry(null)).toBe(false);
        expect(isClipboardHistoryEntry({ id: 1, text: 't', createdAt: 1 })).toBe(false);
        expect(isClipboardHistoryEntry({ id: 'x', text: 't', createdAt: 1, sourceType: 'bogus' })).toBe(false);
    });
});
