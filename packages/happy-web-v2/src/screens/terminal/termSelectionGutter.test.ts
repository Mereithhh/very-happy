import { describe, expect, it } from 'vitest';
import { measureSelectionGutter, normalizeTerminalDomText, stripTerminalSelectionGutter } from './termSelectionGutter';

describe('stripTerminalSelectionGutter (B-574②)', () => {
    it('removes the agent gutter from a code block and keeps relative indentation', () => {
        const sel = [
            '  function f() {',
            '    if (x) {',
            '      return 1;',
            '    }',
            '  }',
        ].join('\n');
        expect(stripTerminalSelectionGutter(sel)).toBe([
            'function f() {',
            '  if (x) {',
            '    return 1;',
            '  }',
            '}',
        ].join('\n'));
    });

    it('keeps YAML nesting intact', () => {
        const sel = '  a:\n    b: 1\n    c:\n      - d\n  e: 2';
        expect(stripTerminalSelectionGutter(sel)).toBe('a:\n  b: 1\n  c:\n    - d\ne: 2');
    });

    it('ignores blank and whitespace-only lines when measuring, and still trims them', () => {
        const sel = '  one\n\n     \n  two';
        expect(measureSelectionGutter(sel)).toBe(2);
        expect(stripTerminalSelectionGutter(sel)).toBe('one\n\n   \ntwo');
    });

    it('returns an all-blank selection unchanged', () => {
        expect(stripTerminalSelectionGutter('   \n\n  ')).toBe('   \n\n  ');
        expect(stripTerminalSelectionGutter('')).toBe('');
    });

    it('treats a tab-led line as zero spaces (nothing stripped)', () => {
        const sel = '  a\n\tb\n  c';
        expect(stripTerminalSelectionGutter(sel)).toBe(sel);
    });

    it('a tab after the shared spaces survives', () => {
        expect(stripTerminalSelectionGutter('  \tx\n  y')).toBe('\tx\ny');
    });

    it('a selection that starts mid-line (first line at col 0) is untouched', () => {
        const sel = 'tail of line\n  next\n  more';
        expect(stripTerminalSelectionGutter(sel)).toBe(sel);
    });

    it('keeps CR terminators and does not let blank CRLF rows pin the gutter', () => {
        expect(stripTerminalSelectionGutter('  a\r\n\r\n  b')).toBe('a\r\n\r\nb');
    });

    it('single line', () => {
        expect(stripTerminalSelectionGutter('    hello')).toBe('hello');
    });

    it('DOM text: NBSP cells become spaces first', () => {
        const dom = '\u00a0\u00a0a:\n\u00a0\u00a0\u00a0\u00a0b';
        expect(stripTerminalSelectionGutter(normalizeTerminalDomText(dom))).toBe('a:\n  b');
    });
});
