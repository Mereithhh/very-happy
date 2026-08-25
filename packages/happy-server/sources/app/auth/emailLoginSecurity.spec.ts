import { beforeEach, describe, expect, it } from 'vitest';
import { generateEmailLoginCode, hashEmailLoginCode, normalizeEmail } from './emailLoginSecurity';

describe('email login security primitives', () => {
    beforeEach(() => { process.env.HANDY_MASTER_SECRET = 'email-code-test-master'; });

    it('normalizes the identity subject and generates fixed-width numeric codes', () => {
        expect(normalizeEmail(' Alice+Work@Example.COM ')).toBe('alice+work@example.com');
        for (let index = 0; index < 50; index += 1) expect(generateEmailLoginCode()).toMatch(/^\d{6}$/);
    });

    it('domain-separates the stored hash across challenge, email, and code', () => {
        const baseline = hashEmailLoginCode('challenge-a', 'a@example.com', '123456');
        expect(baseline).toMatch(/^[a-f0-9]{64}$/);
        expect(hashEmailLoginCode('challenge-b', 'a@example.com', '123456')).not.toBe(baseline);
        expect(hashEmailLoginCode('challenge-a', 'b@example.com', '123456')).not.toBe(baseline);
        expect(hashEmailLoginCode('challenge-a', 'a@example.com', '654321')).not.toBe(baseline);
    });
});
