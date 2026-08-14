/**
 * diff tests — unifiedPatchText (B-101 DiffView copy) must produce a faithful
 * single-hunk patch from the same rows the view renders.
 */
import { describe, expect, it } from 'vitest';
import { lineDiff, unifiedPatchText } from './diff';

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
