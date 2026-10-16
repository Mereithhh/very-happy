/**
 * diff tests — unifiedPatchText (B-101 DiffView copy) must produce a faithful
 * single-hunk patch from the same rows the view renders.
 */
import { describe, expect, it } from 'vitest';
import { lineDiff, pairSplitRows, unifiedPatchText } from './diff';

describe('unifiedPatchText', () => {
    it('serializes a mixed edit as a single hunk with +/-/space prefixes', () => {
        const rows = lineDiff('a\nb\nc', 'a\nB\nc');
        expect(unifiedPatchText(rows)).toBe('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c');
    });

    it('pure insertion (Write tool: oldText empty)', () => {
        const rows = lineDiff('', 'x\ny');
        expect(unifiedPatchText(rows)).toBe('@@ -1,0 +1,2 @@\n+x\n+y');
    });

    it('pure deletion', () => {
        const rows = lineDiff('x\ny', '');
        expect(unifiedPatchText(rows)).toBe('@@ -1,2 +1,0 @@\n-x\n-y');
    });

    it('empty diff yields empty string', () => {
        expect(unifiedPatchText(lineDiff('', ''))).toBe('');
    });
});

describe('pairSplitRows (B-613 split diff)', () => {
    const side = (rows: ReturnType<typeof pairSplitRows>, k: 'old' | 'new') =>
        rows.map((r) => (r[k] ? r[k]!.text : null));

    it('puts context on both sides and pairs a replaced line on one row', () => {
        const rows = pairSplitRows(lineDiff('a\nb\nc', 'a\nB\nc'));
        expect(side(rows, 'old')).toEqual(['a', 'b', 'c']);
        expect(side(rows, 'new')).toEqual(['a', 'B', 'c']);
        expect(rows[1].old?.type).toBe('del');
        expect(rows[1].new?.type).toBe('add');
    });

    it('pads the shorter side of a change block with empty cells', () => {
        const rows = pairSplitRows(lineDiff('a\nb\nz', 'a\nB1\nB2\nB3\nz'));
        expect(side(rows, 'old')).toEqual(['a', 'b', null, null, 'z']);
        expect(side(rows, 'new')).toEqual(['a', 'B1', 'B2', 'B3', 'z']);
    });

    it('pairs within a block only — never across a context line', () => {
        const rows = pairSplitRows([
            { type: 'del', text: 'x', oldNo: 1, newNo: null },
            { type: 'ctx', text: 'k', oldNo: 2, newNo: 1 },
            { type: 'add', text: 'y', oldNo: null, newNo: 2 },
        ]);
        expect(rows).toEqual([
            { old: { type: 'del', text: 'x', oldNo: 1, newNo: null }, new: null },
            { old: { type: 'ctx', text: 'k', oldNo: 2, newNo: 1 }, new: { type: 'ctx', text: 'k', oldNo: 2, newNo: 1 } },
            { old: null, new: { type: 'add', text: 'y', oldNo: null, newNo: 2 } },
        ]);
    });

    it('keeps each side in order when adds and dels interleave inside one block', () => {
        const rows = pairSplitRows([
            { type: 'add', text: 'n1', oldNo: null, newNo: 1 },
            { type: 'del', text: 'o1', oldNo: 1, newNo: null },
            { type: 'del', text: 'o2', oldNo: 2, newNo: null },
            { type: 'add', text: 'n2', oldNo: null, newNo: 2 },
        ]);
        expect(side(rows, 'old')).toEqual(['o1', 'o2']);
        expect(side(rows, 'new')).toEqual(['n1', 'n2']);
    });

    it('each column reproduces its side of the input exactly', () => {
        const oldText = 'l1\nl2\nl3\nl4\nl5\nl6';
        const newText = 'l1\nX\nl3\nY\nZ\nl6\nl7';
        const rows = pairSplitRows(lineDiff(oldText, newText));
        expect(side(rows, 'old').filter((t) => t !== null).join('\n')).toBe(oldText);
        expect(side(rows, 'new').filter((t) => t !== null).join('\n')).toBe(newText);
        const oldNos = rows.map((r) => r.old?.oldNo).filter((n) => n != null);
        expect(oldNos).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('empty input → no rows', () => {
        expect(pairSplitRows([])).toEqual([]);
    });
});
