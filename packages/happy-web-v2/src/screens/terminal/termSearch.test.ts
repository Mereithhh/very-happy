import { describe, expect, it } from 'vitest';
import {
    decorationWindow,
    findTermMatches,
    foldCaseStable,
    formatMatchCount,
    indexOfMatchAt,
    matchTermSearchChord,
    pickInitialIndex,
    scrollTargetFor,
    stepIndex,
    type SearchBufferLike,
    type SearchLineLike,
} from './termSearch';

// Wide chars occupy 2 cells: [char, ''(width 0)] — the exact shape xterm 5.5
// produces (measured with @xterm/headless: '中文ab' → '中','',文','','a','b').
const WIDE = /[一-鿿]/;
function fakeLine(text: string, cols: number, isWrapped = false): SearchLineLike {
    const cells: Array<{ chars: string; width: number }> = [];
    for (const ch of text) {
        if (WIDE.test(ch)) { cells.push({ chars: ch, width: 2 }, { chars: '', width: 0 }); }
        else cells.push({ chars: ch, width: 1 });
    }
    while (cells.length < cols) cells.push({ chars: '', width: 1 });
    return {
        isWrapped,
        length: cols,
        translateToString(trimRight?: boolean) {
            let s = '';
            for (const c of cells) if (c.width !== 0) s += c.chars || ' ';
            return trimRight ? s.replace(/ +$/, '') : s;
        },
        getCell(x: number) {
            const c = cells[x];
            return c ? { getChars: () => c.chars, getWidth: () => c.width } : undefined;
        },
    };
}
function fakeBuffer(lines: SearchLineLike[]): SearchBufferLike {
    return { length: lines.length, getLine: (y) => lines[y] };
}

describe('findTermMatches', () => {
    it('finds plain hits with absolute rows and cell columns', () => {
        const buf = fakeBuffer([fakeLine('foo bar', 10), fakeLine('bar foo foo', 12)]);
        const r = findTermMatches(buf, 'foo', { caseSensitive: true });
        expect(r.truncated).toBe(false);
        expect(r.matches.map((m) => m.segments)).toEqual([
            [{ row: 0, col: 0, width: 3 }],
            [{ row: 1, col: 4, width: 3 }],
            [{ row: 1, col: 8, width: 3 }],
        ]);
    });

    it('joins soft-wrapped rows and splits a crossing hit into per-row segments', () => {
        const buf = fakeBuffer([fakeLine('hello worl', 10), fakeLine('d again', 10, true)]);
        const r = findTermMatches(buf, 'world', { caseSensitive: true });
        expect(r.matches).toHaveLength(1);
        expect(r.matches[0].segments).toEqual([
            { row: 0, col: 6, width: 4 },
            { row: 1, col: 0, width: 1 },
        ]);
    });

    it('does not join across a hard line break', () => {
        const buf = fakeBuffer([fakeLine('hello worl', 10), fakeLine('d', 10, false)]);
        expect(findTermMatches(buf, 'world', { caseSensitive: true }).matches).toHaveLength(0);
    });

    it('maps wide (CJK) characters to their real cell columns and widths', () => {
        const buf = fakeBuffer([fakeLine('中文ab中文', 12)]);
        const r = findTermMatches(buf, 'b中', { caseSensitive: true });
        // 中(0-1) 文(2-3) a(4) b(5) 中(6-7)
        expect(r.matches[0].segments).toEqual([{ row: 0, col: 5, width: 3 }]);
        const r2 = findTermMatches(buf, '中文', { caseSensitive: true });
        expect(r2.matches.map((m) => m.segments[0])).toEqual([
            { row: 0, col: 0, width: 4 },
            { row: 0, col: 6, width: 4 },
        ]);
    });

    it('is case-insensitive unless asked otherwise', () => {
        const buf = fakeBuffer([fakeLine('Error error ERROR', 20)]);
        expect(findTermMatches(buf, 'error', { caseSensitive: false }).matches).toHaveLength(3);
        expect(findTermMatches(buf, 'error', { caseSensitive: true }).matches).toHaveLength(1);
        expect(findTermMatches(buf, 'ERROR', { caseSensitive: false }).matches).toHaveLength(3);
    });

    it('ignores trailing padding on the last row of a logical line', () => {
        const buf = fakeBuffer([fakeLine('ab', 10)]);
        expect(findTermMatches(buf, 'b ', { caseSensitive: true }).matches).toHaveLength(0);
    });

    it('returns nothing for an empty query and truncates at the limit', () => {
        const buf = fakeBuffer([fakeLine('aaaaaaaaaa', 10)]);
        expect(findTermMatches(buf, '', { caseSensitive: false }).matches).toHaveLength(0);
        const r = findTermMatches(buf, 'a', { caseSensitive: false, limit: 4 });
        expect(r.matches).toHaveLength(4);
        expect(r.truncated).toBe(true);
    });

    it('is non-overlapping', () => {
        const buf = fakeBuffer([fakeLine('aaaa', 10)]);
        expect(findTermMatches(buf, 'aa', { caseSensitive: true }).matches).toHaveLength(2);
    });
});

describe('foldCaseStable', () => {
    it('never changes length', () => {
        const s = 'İstanbul ABC';
        expect(foldCaseStable(s)).toHaveLength(s.length);
        expect(foldCaseStable('ABC')).toBe('abc');
    });
});

describe('navigation helpers', () => {
    const m = (row: number, col = 0) => ({ segments: [{ row, col, width: 1 }] });

    it('pickInitialIndex takes the last hit at or above the anchor row', () => {
        const ms = [m(2), m(10), m(50)];
        expect(pickInitialIndex(ms, 40)).toBe(1);
        expect(pickInitialIndex(ms, 50)).toBe(2);
        expect(pickInitialIndex(ms, 1)).toBe(0);
        expect(pickInitialIndex([], 10)).toBe(-1);
    });

    it('indexOfMatchAt finds a hit by its first cell', () => {
        const ms = [m(2, 1), m(2, 5), m(9, 0)];
        expect(indexOfMatchAt(ms, 2, 5)).toBe(1);
        expect(indexOfMatchAt(ms, 3, 0)).toBe(-1);
    });

    it('stepIndex wraps both ways', () => {
        expect(stepIndex(0, 3, -1)).toBe(2);
        expect(stepIndex(2, 3, 1)).toBe(0);
        expect(stepIndex(-1, 3, 1)).toBe(0);
        expect(stepIndex(-1, 3, -1)).toBe(2);
        expect(stepIndex(0, 0, 1)).toBe(-1);
    });

    it('scrollTargetFor leaves visible rows alone and centers a third down otherwise', () => {
        expect(scrollTargetFor(105, 100, 24)).toBeNull();
        expect(scrollTargetFor(10, 100, 24)).toBe(2);
        expect(scrollTargetFor(3, 100, 24)).toBe(0);
        expect(scrollTargetFor(200, 100, 24)).toBe(192);
    });

    it('decorationWindow keeps everything under the limit, else a window around the active hit', () => {
        expect(decorationWindow(10, 3, 100)).toEqual([0, 10]);
        expect(decorationWindow(5000, 2500, 1000)).toEqual([2000, 3000]);
        expect(decorationWindow(5000, 10, 1000)).toEqual([0, 1000]);
        expect(decorationWindow(5000, 4990, 1000)).toEqual([4000, 5000]);
        expect(decorationWindow(5000, -1, 1000)).toEqual([4000, 5000]);
    });

    it('formatMatchCount', () => {
        expect(formatMatchCount(2, 17, false)).toBe('3/17');
        expect(formatMatchCount(-1, 0, false)).toBe('0/0');
        expect(formatMatchCount(0, 2000, true)).toBe('1/2000+');
    });
});

describe('matchTermSearchChord', () => {
    const ev = (o: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; code: string }>) => ({
        metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, code: 'KeyF', ...o,
    });
    it('mac: ⌘F only', () => {
        expect(matchTermSearchChord(ev({ metaKey: true }), true)).toBe(true);
        expect(matchTermSearchChord(ev({ ctrlKey: true }), true)).toBe(false); // Ctrl+F = forward-char
        expect(matchTermSearchChord(ev({ metaKey: true, shiftKey: true }), true)).toBe(false);
        expect(matchTermSearchChord(ev({ metaKey: true, altKey: true }), true)).toBe(false);
        expect(matchTermSearchChord(ev({ metaKey: true, code: 'KeyG' }), true)).toBe(false);
    });
    it('non-mac: Ctrl+Shift+F, never plain Ctrl+F (a real terminal key)', () => {
        expect(matchTermSearchChord(ev({ ctrlKey: true, shiftKey: true }), false)).toBe(true);
        expect(matchTermSearchChord(ev({ ctrlKey: true }), false)).toBe(false);
        expect(matchTermSearchChord(ev({ ctrlKey: true, shiftKey: true, altKey: true }), false)).toBe(false);
    });
});
