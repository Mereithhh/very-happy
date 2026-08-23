import { describe, expect, it } from 'vitest';
import { remoteLogTokenMatches } from './devRoutes';

describe('remote log authorization', () => {
    it('fails closed without a configured token', () => {
        expect(remoteLogTokenMatches('Bearer anything', undefined)).toBe(false);
    });

    it('accepts only an exact bearer token', () => {
        expect(remoteLogTokenMatches('Bearer test-token', 'test-token')).toBe(true);
        expect(remoteLogTokenMatches('Bearer test-tokeN', 'test-token')).toBe(false);
        expect(remoteLogTokenMatches('Basic test-token', 'test-token')).toBe(false);
        expect(remoteLogTokenMatches(undefined, 'test-token')).toBe(false);
    });
});
