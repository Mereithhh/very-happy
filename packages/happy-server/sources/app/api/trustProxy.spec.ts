import { describe, expect, it } from 'vitest';
import { resolveTrustProxy } from './trustProxy';

describe('trusted proxy configuration', () => {
    it('defaults to direct-client addresses and accepts explicit safe forms', () => {
        expect(resolveTrustProxy(undefined)).toBe(false);
        expect(resolveTrustProxy('1')).toBe(1);
        expect(resolveTrustProxy('127.0.0.1,10.0.0.0/8')).toEqual(['127.0.0.1', '10.0.0.0/8']);
        expect(() => resolveTrustProxy('true')).toThrow('TRUST_PROXY');
        expect(() => resolveTrustProxy('*')).toThrow('TRUST_PROXY');
    });
});
