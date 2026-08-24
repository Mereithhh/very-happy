import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
    E2EE_CONTROL_DEVICE_ROOT_ENVELOPE_DOMAIN,
    E2EE_RECOVERY_CAPSULE_DOMAIN,
    E2EE_SUITE_V1,
} from '@slopus/happy-wire';
import {
    canonicalizeE2eeTranscript,
    decodeCanonicalBase64Url,
    passwordSignupTranscript,
    verifyRecoveryAuthoritySignature,
} from './e2eeAuth';
import { resolveE2eeSignupConfig } from './e2eeConfig';

describe('E2EE auth primitives', () => {
    it('keeps both rollout switches disabled by default and rejects typos', () => {
        expect(resolveE2eeSignupConfig({})).toEqual({ enabled: false, required: false });
        expect(resolveE2eeSignupConfig({ E2EE_SIGNUP_ENABLED: 'true', E2EE_SIGNUP_REQUIRED: '1' }))
            .toEqual({ enabled: true, required: true });
        expect(() => resolveE2eeSignupConfig({ E2EE_SIGNUP_ENABLED: 'yes' })).toThrow(/E2EE_SIGNUP_ENABLED/);
        expect(() => resolveE2eeSignupConfig({ E2EE_SIGNUP_REQUIRED: 'true' }))
            .toThrow(/requires E2EE_SIGNUP_ENABLED=true/);
    });

    it('accepts only canonical unpadded base64url', () => {
        const value = Buffer.alloc(32, 0xfb).toString('base64url');
        expect(decodeCanonicalBase64Url(value, { exactBytes: 32 })).toEqual(Buffer.alloc(32, 0xfb));
        expect(decodeCanonicalBase64Url(`${value}=`, { exactBytes: 32 })).toBeNull();
        expect(decodeCanonicalBase64Url(Buffer.alloc(31).toString('base64url'), { exactBytes: 32 })).toBeNull();
    });

    it('canonicalizes transcripts and fails closed when any bound field changes', () => {
        expect(canonicalizeE2eeTranscript({ z: 'last', a: 'first', epoch: 1 }).toString())
            .toBe('{"a":"first","epoch":1,"z":"last"}');
        const authority = tweetnacl.sign.keyPair();
        const publicKey = Buffer.from(authority.publicKey).toString('base64url');
        const recoveryCapsule = {
            v: 1 as const,
            domain: E2EE_RECOVERY_CAPSULE_DOMAIN,
            suite: E2EE_SUITE_V1,
            origin: 'https://happy.example',
            accountId: 'account-1',
            currentEpoch: 1,
            recoveryAuthorityPublicKey: publicKey,
            nonce: Buffer.alloc(24, 7).toString('base64url'),
            ciphertext: Buffer.alloc(64, 3).toString('base64url'),
            signature: Buffer.alloc(64, 8).toString('base64url'),
        };
        const rootEnvelope = {
            v: 1 as const,
            domain: E2EE_CONTROL_DEVICE_ROOT_ENVELOPE_DOMAIN,
            suite: E2EE_SUITE_V1,
            origin: 'https://happy.example',
            accountId: 'account-1',
            deviceId: '42dc0ca7-e24d-4d38-acb9-699097ba4b94',
            keyEpoch: 1,
            ephemeralPublicKey: Buffer.alloc(32, 9).toString('base64url'),
            nonce: Buffer.alloc(24, 10).toString('base64url'),
            ciphertext: Buffer.alloc(64, 4).toString('base64url'),
            authorizer: { kind: 'recovery' as const },
            signature: Buffer.alloc(64, 11).toString('base64url'),
        };
        const transcript = passwordSignupTranscript({
            origin: 'https://happy.example',
            accountId: 'account-1',
            nonce: Buffer.alloc(32, 1).toString('base64url'),
            username: 'alice',
            recoveryAuthorityPublicKey: publicKey,
            contentPublicKey: Buffer.alloc(32, 2).toString('base64url'),
            recoveryCapsule,
            rootEnvelope,
            device: {
                id: '42dc0ca7-e24d-4d38-acb9-699097ba4b94',
                type: 'web',
                encryptionPublicKey: Buffer.alloc(32, 5).toString('base64url'),
                signingPublicKey: Buffer.alloc(32, 6).toString('base64url'),
            },
        });
        const signature = Buffer.from(tweetnacl.sign.detached(
            canonicalizeE2eeTranscript(transcript),
            authority.secretKey,
        )).toString('base64url');
        expect(verifyRecoveryAuthoritySignature(publicKey, signature, transcript)).toBe(true);
        expect(verifyRecoveryAuthoritySignature(publicKey, signature, { ...transcript, normalizedIdentity: 'mallory' })).toBe(false);
    });
});
