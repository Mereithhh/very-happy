import { describe, expect, it } from 'vitest';
import { hashLoginToken, parseLoginSessionTtlDays } from './auth';

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
});
