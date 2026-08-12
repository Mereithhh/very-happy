import { describe, it, expect } from 'vitest';
import { presetPasteText } from './termPresetPaste';

describe('presetPasteText', () => {
    it('passes plain single-line text through unchanged', () => {
        expect(presetPasteText('review this diff')).toBe('review this diff');
    });

    it('normalizes CRLF and lone CR line endings to LF', () => {
        expect(presetPasteText('a\r\nb\r\nc')).toBe('a\nb\nc');
        expect(presetPasteText('a\rb')).toBe('a\nb');
    });

    it('strips trailing newlines so a paste can never auto-submit', () => {
        expect(presetPasteText('run the tests\n')).toBe('run the tests');
        expect(presetPasteText('run the tests\n\n\n')).toBe('run the tests');
        expect(presetPasteText('run the tests\r\n')).toBe('run the tests');
    });

    it('strips trailing spaces/tabs (incl. after a final newline)', () => {
        expect(presetPasteText('prompt  \t')).toBe('prompt');
        expect(presetPasteText('prompt\n  \n\t')).toBe('prompt');
    });

    it('preserves inner newlines and indentation of multi-line prompts', () => {
        const preset = 'Fix the bug:\n  - step 1\n  - step 2';
        expect(presetPasteText(preset)).toBe(preset);
        expect(presetPasteText(preset + '\n')).toBe(preset);
    });

    it('preserves leading whitespace (only the tail is stripped)', () => {
        expect(presetPasteText('  indented start')).toBe('  indented start');
    });

    it('returns empty string for empty / whitespace-only presets', () => {
        expect(presetPasteText('')).toBe('');
        expect(presetPasteText('   \n\t\r\n')).toBe('');
    });
});
