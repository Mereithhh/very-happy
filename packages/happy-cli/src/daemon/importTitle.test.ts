import { describe, expect, it } from 'vitest';
import { sanitizeImportTitle } from './run';

const CONTROL = String.fromCharCode(27) + '[31m';

describe('sanitizeImportTitle (B-292)', () => {
    it('collapses a transcript title into one env-safe line', () => {
        expect(sanitizeImportTitle('  Login bug\n investigation  ')).toBe('Login bug investigation');
        expect(sanitizeImportTitle('\u4fee\u590d\u767b\u5f55\t\u95ee\u9898')).toBe('\u4fee\u590d\u767b\u5f55 \u95ee\u9898');
    });

    it('drops control characters that would break the spawn env', () => {
        expect(sanitizeImportTitle(`title ${CONTROL} with escapes`)).toBe('title [31m with escapes');
    });

    it('clamps very long titles and rejects empty or non-string input', () => {
        const long = sanitizeImportTitle('x'.repeat(500));
        expect(long).toHaveLength(200);
        expect(long?.endsWith('\u2026')).toBe(true);
        expect(sanitizeImportTitle('   ')).toBeNull();
        expect(sanitizeImportTitle(undefined)).toBeNull();
        expect(sanitizeImportTitle(42)).toBeNull();
    });
});
