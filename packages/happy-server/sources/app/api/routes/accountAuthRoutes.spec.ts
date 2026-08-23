import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './accountAuthRoutes';

describe('password credential hashing', () => {
    it('stores a salted scrypt hash and verifies only the matching password', () => {
        const first = hashPassword('correct horse battery staple');
        const second = hashPassword('correct horse battery staple');
        expect(first).toMatch(/^scrypt\$[a-f0-9]+\$[a-f0-9]+$/);
        expect(first).not.toBe(second);
        expect(verifyPassword('correct horse battery staple', first)).toBe(true);
        expect(verifyPassword('wrong password', first)).toBe(false);
    });

    it('fails closed for malformed stored values', () => {
        expect(verifyPassword('password', 'plaintext')).toBe(false);
        expect(verifyPassword('password', 'scrypt$not-hex$also-not-hex')).toBe(false);
    });
});
