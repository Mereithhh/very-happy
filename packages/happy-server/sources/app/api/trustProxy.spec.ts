import { describe, expect, it } from 'vitest';
import { resolveTrustProxy } from './trustProxy';
import { StartupConfigError } from '@/utils/startupConfigError';

describe('trusted proxy configuration', () => {
    it('defaults to direct-client addresses and accepts explicit safe forms', () => {
        expect(resolveTrustProxy(undefined)).toBe(false);
        expect(resolveTrustProxy('172.18.0.1')).toEqual(['172.18.0.1']);
        expect(resolveTrustProxy('loopback,uniquelocal')).toEqual(['loopback', 'uniquelocal']);
        expect(resolveTrustProxy('127.0.0.1,10.0.0.0/8')).toEqual(['127.0.0.1', '10.0.0.0/8']);
        expect(() => resolveTrustProxy('true')).toThrow(StartupConfigError);
        expect(() => resolveTrustProxy('*')).toThrow('TRUST_PROXY');
    });

    it('B-820b: a hop count fails startup with a message one can act on', () => {
        for (const value of ['1', '2', ' 1 ', '0']) {
            expect(() => resolveTrustProxy(value)).toThrow(StartupConfigError);
            expect(() => resolveTrustProxy(value)).toThrow(/is a hop count, which is no longer supported: Fastify >= 5\.12/);
        }
        let message = '';
        try { resolveTrustProxy('1'); } catch (error) { message = (error as Error).message; }
        expect(message).toContain('TRUST_PROXY=172.18.0.1');
        expect(message).toContain('TRUST_PROXY=10.0.0.0/8');
        expect(message).toContain('TRUST_PROXY=loopback,uniquelocal');
        expect(message).toContain('rate-limit bucket');
    });
});
