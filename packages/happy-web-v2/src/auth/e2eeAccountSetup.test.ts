import { describe, expect, it } from 'vitest';
import sodium from '@/encryption/libsodium.lib';
import {
    generateControlDeviceKeyPairs,
    openControlDeviceRootEnvelope,
} from './e2eeDeviceEnvelope';
import {
    deriveRecoveryAuthorityKeyPair,
} from './e2eeKeyHierarchy';
import {
    openRecoveryKeyringCapsule,
    serializeRecoveryKeyringCapsule,
} from './e2eeRecoveryCapsule';
import { decodeE2eeRecoveryCode } from './e2eeRecoveryCode';
import {
    E2EE_CONTROL_CAPABILITY,
    disposeControlDeviceKeys,
    disposePreparedE2eeSignup,
    prepareE2eeDeviceActivation,
    prepareE2eePasswordSignup,
    type PendingE2eeDeviceLogin,
} from './e2eeAccountSetup';
import {
    decodeBase64UrlCanonical,
    encodeBase64UrlCanonical,
    utf8,
} from '@/sync/encryption/e2eeEncoding';
import { jcsCanonicalize } from '@/sync/encryption/e2eeJcs';

async function sha256Base64Url(value: string): Promise<string> {
    return encodeBase64UrlCanonical(new Uint8Array(
        await crypto.subtle.digest('SHA-256', utf8(value) as BufferSource),
    ));
}

describe('E2EE account setup transcripts', () => {
    it('creates a recovery-confirmed signup whose proofs and envelopes verify independently', async () => {
        const prepared = await prepareE2eePasswordSignup({
            origin: 'https://happy.example',
            challenge: {
                accountId: 'c0a80101-0000-4000-8000-000000000001',
                nonce: encodeBase64UrlCanonical(new Uint8Array(32).fill(7)),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                suite: 'vh-e2ee-1',
            },
            username: '  Alice  ',
        });
        expect(prepared.normalizedUsername).toBe('alice');
        expect(prepared.recoveryCode).toMatch(/^VH1-/);

        const rrk = await decodeE2eeRecoveryCode(prepared.recoveryCode);
        const opened = await openRecoveryKeyringCapsule({
            capsule: prepared.recoveryCapsule,
            recoveryRootKey: rrk,
            expectedOrigin: prepared.origin,
            expectedAccountId: prepared.accountId,
            expectedRecoveryAuthorityPublicKey: prepared.recoveryAuthorityPublicKey,
        });
        const authority = await deriveRecoveryAuthorityKeyPair(opened.recoveryAuthoritySeed);
        await expect(openControlDeviceRootEnvelope({
            envelope: prepared.rootEnvelope,
            recipientEncryptionPrivateKey: prepared.deviceKeys.encryptionPrivateKey,
            authorizerSigningPublicKey: authority.publicKey,
            expectedOrigin: prepared.origin,
            expectedAccountId: prepared.accountId,
            expectedDeviceId: prepared.device.id,
            expectedAuthorizer: { kind: 'recovery' },
        })).resolves.toEqual(prepared.keyring);

        const transcript = {
            accountId: prepared.accountId,
            capability: E2EE_CONTROL_CAPABILITY,
            contentPublicKey: prepared.contentPublicKey,
            deviceEncryptionPublicKey: prepared.device.encryptionPublicKey,
            deviceId: prepared.device.id,
            deviceSigningPublicKey: prepared.device.signingPublicKey,
            deviceType: prepared.device.type,
            domain: 'very-happy/vh-e2ee-1/signup',
            epoch: 1,
            normalizedIdentity: 'alice',
            origin: prepared.origin,
            provider: 'password',
            recoveryAuthorityPublicKey: prepared.recoveryAuthorityPublicKey,
            recoveryCiphertextHash: await sha256Base64Url(
                serializeRecoveryKeyringCapsule(prepared.recoveryCapsule),
            ),
            rootEnvelopeCiphertextHash: await sha256Base64Url(jcsCanonicalize(prepared.rootEnvelope)),
            signupNonce: prepared.signupNonce,
            suite: 'vh-e2ee-1',
        };
        await sodium.ready;
        expect(sodium.crypto_sign_verify_detached(
            decodeBase64UrlCanonical(prepared.signupProof, { exactBytes: 64 }),
            utf8(jcsCanonicalize(transcript)),
            authority.publicKey,
        )).toBe(true);

        rrk.fill(0);
        opened.recoveryAuthoritySeed.fill(0);
        opened.keyring.epochs.forEach((item) => item.secret.fill(0));
        authority.privateKey.fill(0);
        disposePreparedE2eeSignup(prepared);
    });

    it('uses the saved code to authorize a distinct pending browser', async () => {
        const signup = await prepareE2eePasswordSignup({
            origin: 'https://happy.example',
            challenge: {
                accountId: 'c0a80101-0000-4000-8000-000000000002',
                nonce: encodeBase64UrlCanonical(new Uint8Array(32).fill(8)),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                suite: 'vh-e2ee-1',
            },
            username: 'bob',
        });
        const nextKeys = await generateControlDeviceKeyPairs();
        const pending: PendingE2eeDeviceLogin = {
            token: 'pending-token',
            accountId: signup.accountId,
            deviceId: 'c0a80101-0000-4000-8000-000000000003',
            origin: signup.origin,
            cryptoEpoch: 1,
            recoveryAuthorityPublicKey: signup.recoveryAuthorityPublicKey,
            contentPublicKey: signup.contentPublicKey,
            contentKeySignature: signup.contentKeySignature,
            recoveryCapsule: signup.recoveryCapsule,
            device: {
                id: 'c0a80101-0000-4000-8000-000000000003',
                type: 'web',
                encryptionPublicKey: encodeBase64UrlCanonical(nextKeys.encryptionPublicKey),
                signingPublicKey: encodeBase64UrlCanonical(nextKeys.signingPublicKey),
            },
            deviceKeys: nextKeys,
        };
        const activation = await prepareE2eeDeviceActivation({
            pending,
            recoveryCode: signup.recoveryCode,
        });
        const rrk = await decodeE2eeRecoveryCode(signup.recoveryCode);
        const opened = await openRecoveryKeyringCapsule({
            capsule: signup.recoveryCapsule,
            recoveryRootKey: rrk,
            expectedOrigin: signup.origin,
            expectedAccountId: signup.accountId,
        });
        const authority = await deriveRecoveryAuthorityKeyPair(opened.recoveryAuthoritySeed);
        await expect(openControlDeviceRootEnvelope({
            envelope: activation.rootEnvelope,
            recipientEncryptionPrivateKey: nextKeys.encryptionPrivateKey,
            authorizerSigningPublicKey: authority.publicKey,
            expectedOrigin: pending.origin,
            expectedAccountId: pending.accountId,
            expectedDeviceId: pending.deviceId,
            expectedAuthorizer: { kind: 'recovery' },
        })).resolves.toEqual(activation.keyring);
        expect(sodium.crypto_sign_verify_detached(
            decodeBase64UrlCanonical(activation.activationProof, { exactBytes: 64 }),
            utf8(jcsCanonicalize({
                accountId: pending.accountId,
                authorizerKind: 'recovery',
                capability: E2EE_CONTROL_CAPABILITY,
                challenge: await sha256Base64Url(pending.token),
                deviceEncryptionPublicKey: pending.device.encryptionPublicKey,
                deviceId: pending.device.id,
                deviceSigningPublicKey: pending.device.signingPublicKey,
                deviceType: pending.device.type,
                domain: 'very-happy/vh-e2ee-1/device-root-envelope',
                envelopeHash: await sha256Base64Url(jcsCanonicalize(activation.rootEnvelope)),
                epoch: pending.cryptoEpoch,
                origin: pending.origin,
                suite: 'vh-e2ee-1',
            })),
            authority.publicKey,
        )).toBe(true);

        rrk.fill(0);
        opened.recoveryAuthoritySeed.fill(0);
        opened.keyring.epochs.forEach((item) => item.secret.fill(0));
        activation.keyring.epochs.forEach((item) => item.secret.fill(0));
        authority.privateKey.fill(0);
        disposeControlDeviceKeys(nextKeys);
        disposePreparedE2eeSignup(signup);
    });

    it('rejects a wrong recovery code before constructing an activation', async () => {
        const signup = await prepareE2eePasswordSignup({
            origin: 'https://happy.example',
            challenge: {
                accountId: 'c0a80101-0000-4000-8000-000000000004',
                nonce: encodeBase64UrlCanonical(new Uint8Array(32).fill(9)),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                suite: 'vh-e2ee-1',
            },
            username: 'carol',
        });
        const pending = {
            token: 'pending-token', accountId: signup.accountId,
            deviceId: signup.device.id, origin: signup.origin, cryptoEpoch: 1,
            recoveryAuthorityPublicKey: signup.recoveryAuthorityPublicKey,
            contentPublicKey: signup.contentPublicKey,
            contentKeySignature: signup.contentKeySignature,
            recoveryCapsule: signup.recoveryCapsule,
            device: signup.device,
            deviceKeys: signup.deviceKeys,
        } satisfies PendingE2eeDeviceLogin;
        const wrong = `${signup.recoveryCode.slice(0, -1)}${signup.recoveryCode.endsWith('A') ? 'B' : 'A'}`;
        await expect(prepareE2eeDeviceActivation({ pending, recoveryCode: wrong })).rejects.toThrow();
        disposePreparedE2eeSignup(signup);
    });
});
