import { describe, expect, it } from 'vitest';
import { hashLoginToken, parseLoginSessionTtlDays, parseMaxLoginSessionsPerAccount } from './auth';

describe('login session primitives', () => {
    it('uses a bounded configurable TTL', () => {
        expect(parseLoginSessionTtlDays(undefined)).toBe(30);
        expect(parseLoginSessionTtlDays('7')).toBe(7);
        expect(parseLoginSessionTtlDays('0')).toBe(30);
        expect(parseLoginSessionTtlDays('366')).toBe(30);
        expect(parseLoginSessionTtlDays('nope')).toBe(30);
    });

    it('stores only a deterministic token hash', () => {
        expect(hashLoginToken('secret-token')).toMatch(/^[a-f0-9]{64}$/);
        expect(hashLoginToken('secret-token')).toBe(hashLoginToken('secret-token'));
        expect(hashLoginToken('secret-token')).not.toContain('secret-token');
    });

    it('uses a bounded configurable per-account session cap', () => {
        expect(parseMaxLoginSessionsPerAccount(undefined)).toBe(20);
        expect(parseMaxLoginSessionsPerAccount('1')).toBe(1);
        expect(parseMaxLoginSessionsPerAccount('1000')).toBe(1000);
        expect(parseMaxLoginSessionsPerAccount('0')).toBe(20);
        expect(parseMaxLoginSessionsPerAccount('1001')).toBe(20);
        expect(parseMaxLoginSessionsPerAccount('nope')).toBe(20);
    });
});
