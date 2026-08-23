import { describe, expect, it } from 'vitest';
import { remoteLogTokenMatches } from './devRoutes';

describe('remote log authorization', () => {
    it('fails closed without a configured token', () => {
        expect(remoteLogTokenMatches('Bearer anything', undefined)).toBe(false);
    });

    it('accepts only an exact bearer token', () => {
        const token = 'x'.repeat(32);
        expect(remoteLogTokenMatches(`Bearer ${token}`, token)).toBe(true);
        expect(remoteLogTokenMatches(`Bearer ${'y'.repeat(32)}`, token)).toBe(false);
        expect(remoteLogTokenMatches(`Basic ${token}`, token)).toBe(false);
        expect(remoteLogTokenMatches(undefined, token)).toBe(false);
        expect(remoteLogTokenMatches('Bearer short', 'short')).toBe(false);
    });
});
