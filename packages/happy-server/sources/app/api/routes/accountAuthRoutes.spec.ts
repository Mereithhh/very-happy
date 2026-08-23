import { describe, expect, it } from 'vitest';
import {
    accountPublicKeyFromSecret,
    consumeRateBucketsSequentially,
    hashPassword,
    passwordLoginRateBuckets,
    verifyPassword,
} from './accountAuthRoutes';

describe('password credential hashing', () => {
    it('stores a salted scrypt hash and verifies only the matching password', async () => {
        const first = await hashPassword('correct horse battery staple');
        const second = await hashPassword('correct horse battery staple');
        expect(first).toMatch(/^scrypt\$[a-f0-9]+\$[a-f0-9]+$/);
        expect(first).not.toBe(second);
        await expect(verifyPassword('correct horse battery staple', first)).resolves.toBe(true);
        await expect(verifyPassword('wrong password', first)).resolves.toBe(false);
    });

    it('fails closed for malformed stored values', async () => {
        await expect(verifyPassword('password', 'plaintext')).resolves.toBe(false);
        await expect(verifyPassword('password', 'scrypt$not-hex$also-not-hex')).resolves.toBe(false);
    });
});

describe('password signup secret validation', () => {
    it('derives a stable account key only from a 32-byte secret', () => {
        const secret = Buffer.alloc(32, 7).toString('base64url');
        expect(accountPublicKeyFromSecret(secret)).toMatch(/^[a-f0-9]{64}$/);
        expect(accountPublicKeyFromSecret(secret)).toBe(accountPublicKeyFromSecret(secret));
        expect(accountPublicKeyFromSecret(Buffer.alloc(31, 7).toString('base64url'))).toBeNull();
        expect(accountPublicKeyFromSecret('not-base64')).toBeNull();
    });
});

describe('password login abuse buckets', () => {
    it('shares IP and global limits even when an attacker rotates usernames', () => {
        const first = passwordLoginRateBuckets('203.0.113.7', 'alice');
        const second = passwordLoginRateBuckets('203.0.113.7', 'bob');
        expect(first[0]).toEqual(second[0]);
        expect(first[1].key).not.toBe(second[1].key);
        expect(first[2]).toEqual(second[2]);
        expect(JSON.stringify(first)).not.toMatch(/203\.0\.113\.7|alice/);
    });

    it('stops at the rejected IP bucket without consuming the global bucket', async () => {
        const calls: string[] = [];
        const consume = async (key: string) => {
            calls.push(key);
            return !key.includes(':ip:');
        };
        const buckets = passwordLoginRateBuckets('203.0.113.7', 'rotating-user');
        await expect(consumeRateBucketsSequentially(buckets, consume)).resolves.toBe(false);
        expect(calls).toEqual([buckets[0].key]);
        expect(calls).not.toContain('password-login:global');
    });
});
