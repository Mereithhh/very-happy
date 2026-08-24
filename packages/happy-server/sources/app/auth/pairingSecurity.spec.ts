import { afterEach, describe, expect, it } from 'vitest';
import {
    claimSecretHash,
    claimSecretMatches,
    decodeFixedBase64,
    legacyPairingAllowed,
    maxPendingAuthPairings,
    pairingExpired,
    pairingExpiryCutoff,
} from './pairingSecurity';

describe('pairing claim security', () => {
    afterEach(() => {
        delete process.env.AUTH_PAIRING_TTL_MINUTES;
        delete process.env.AUTH_ALLOW_LEGACY_PAIRING;
        delete process.env.MAX_PENDING_AUTH_PAIRINGS;
    });

    it('accepts exactly 32 byte base64url claims and rejects malformed lengths', () => {
        const claim = Buffer.alloc(32, 7).toString('base64url');
        expect(decodeFixedBase64(claim, 32)).toEqual(Buffer.alloc(32, 7));
        expect(decodeFixedBase64(Buffer.alloc(31).toString('base64url'), 32)).toBeNull();
        expect(decodeFixedBase64(`${claim}!`, 32)).toBeNull();
    });

    it('stores only a digest and rejects a wrong claim', () => {
        const right = Buffer.alloc(32, 1).toString('base64url');
        const wrong = Buffer.alloc(32, 2).toString('base64url');
        const digest = claimSecretHash(right)!;
        expect(digest).toHaveLength(64);
        expect(digest).not.toContain(right);
        expect(claimSecretMatches(right, digest)).toBe(true);
        expect(claimSecretMatches(wrong, digest)).toBe(false);
    });

    it('expires at the configured TTL and defaults legacy pairing off', () => {
        process.env.AUTH_PAIRING_TTL_MINUTES = '10';
        const createdAt = new Date('2026-08-24T00:00:00Z');
        expect(pairingExpired(createdAt, new Date('2026-08-24T00:09:59Z'))).toBe(false);
        expect(pairingExpired(createdAt, new Date('2026-08-24T00:10:00Z'))).toBe(true);
        expect(legacyPairingAllowed()).toBe(false);
        process.env.AUTH_ALLOW_LEGACY_PAIRING = 'true';
        expect(legacyPairingAllowed()).toBe(true);
    });

    it('uses the same bounded TTL cutoff and a safe configurable global cap', () => {
        process.env.AUTH_PAIRING_TTL_MINUTES = '10';
        const now = new Date('2026-08-24T00:10:00Z');
        expect(pairingExpiryCutoff(now)).toEqual(new Date('2026-08-24T00:00:00Z'));
        expect(maxPendingAuthPairings()).toBe(1000);
        process.env.MAX_PENDING_AUTH_PAIRINGS = '25';
        expect(maxPendingAuthPairings()).toBe(25);
        process.env.MAX_PENDING_AUTH_PAIRINGS = '0';
        expect(maxPendingAuthPairings()).toBe(1000);
    });
});
