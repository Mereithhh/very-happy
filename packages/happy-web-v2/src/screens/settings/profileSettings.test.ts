import { describe, expect, it } from 'vitest';
import { handleIssue } from './profileHandle';

describe('profile handle validation (B-621)', () => {
    it('accepts lowercase handles 3–64 chars with _ . -', () => {
        expect(handleIssue('alice')).toBe('ok');
        expect(handleIssue('Alice.B-1_')).toBe('ok');
    });
    it('empty is allowed (clears the handle); too short or spaces are not', () => {
        expect(handleIssue('')).toBe('empty');
        expect(handleIssue('  ')).toBe('empty');
        expect(handleIssue('ab')).toBe('invalid');
        expect(handleIssue('a b')).toBe('invalid');
        expect(handleIssue('-abc')).toBe('invalid');
    });
});
