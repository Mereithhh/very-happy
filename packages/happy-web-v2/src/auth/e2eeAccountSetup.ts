import sodium from '@/encryption/libsodium.lib';
import type {
    ControlDeviceRootEnvelopeV1,
    RecoveryKeyringCapsuleV1,
} from '@slopus/happy-wire';
import { randomUUID } from 'expo-crypto';
import {
    createControlDeviceRootEnvelope,
    generateControlDeviceKeyPairs,
    type ControlDeviceKeyPairs,
} from './e2eeDeviceEnvelope';
import {
    deriveEpochContentKeyPair,
    deriveRecoveryAuthorityKeyPair,
    generateInitialE2eeKeyHierarchy,
    signEpochContentKey,
} from './e2eeKeyHierarchy';
import {
    createRecoveryKeyringCapsule,
    openRecoveryKeyringCapsule,
    serializeRecoveryKeyringCapsule,
    type E2eeEpochKeyring,
} from './e2eeRecoveryCapsule';
import { decodeE2eeRecoveryCode, encodeE2eeRecoveryCode } from './e2eeRecoveryCode';
import {
    E2EE_SUITE,
    encodeBase64UrlCanonical,
    utf8,
} from '@/sync/encryption/e2eeEncoding';
import { assertE2eeAccountId, assertE2eeOrigin } from '@/sync/encryption/e2eeContext';
import { jcsCanonicalize } from '@/sync/encryption/e2eeJcs';

export const E2EE_CONTROL_CAPABILITY = 'e2ee:control' as const;
export const E2EE_UNLOCK_CAPABILITY = 'e2ee:unlock' as const;

export interface E2eeDevicePublicInput {
    id: string;
    type: 'web';
    encryptionPublicKey: string;
    signingPublicKey: string;
}

export interface E2eeSignupChallenge {
    accountId: string;
    nonce: string;
    expiresAt: string;
    suite: typeof E2EE_SUITE;
}

export interface PreparedE2eePasswordSignup {
    origin: string;
    accountId: string;
    signupNonce: string;
    normalizedUsername: string;
    recoveryCode: string;
    recoveryAuthorityPublicKey: string;
    contentPublicKey: string;
    contentKeySignature: string;
    recoveryCapsule: RecoveryKeyringCapsuleV1;
    device: E2eeDevicePublicInput;
    rootEnvelope: ControlDeviceRootEnvelopeV1;
    signupProof: string;
    keyring: E2eeEpochKeyring;
    deviceKeys: ControlDeviceKeyPairs;
}

export interface PendingE2eeDeviceLogin {
    token: string;
    accountId: string;
    deviceId: string;
    origin: string;
    cryptoEpoch: number;
    recoveryAuthorityPublicKey: string;
    contentPublicKey: string;
    contentKeySignature: string;
    recoveryCapsule: RecoveryKeyringCapsuleV1;
    device: E2eeDevicePublicInput;
    deviceKeys: ControlDeviceKeyPairs;
}

export interface PreparedE2eeDeviceActivation {
    rootEnvelope: ControlDeviceRootEnvelopeV1;
    activationProof: string;
    keyring: E2eeEpochKeyring;
}

async function sha256Base64Url(value: string): Promise<string> {
    const bytes = utf8(value);
    try {
        const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
        return encodeBase64UrlCanonical(new Uint8Array(digest));
    } finally {
        bytes.fill(0);
    }
}

async function signFlatTranscript(
    transcript: Record<string, string | number | boolean | null>,
    signingPrivateKey: Uint8Array,
): Promise<string> {
    await sodium.ready;
    const bytes = utf8(jcsCanonicalize(transcript));
    try {
        return encodeBase64UrlCanonical(sodium.crypto_sign_detached(bytes, signingPrivateKey));
    } finally {
        bytes.fill(0);
    }
}

function devicePublicInput(deviceId: string, keys: ControlDeviceKeyPairs): E2eeDevicePublicInput {
    return {
        id: deviceId,
        type: 'web',
        encryptionPublicKey: encodeBase64UrlCanonical(keys.encryptionPublicKey),
        signingPublicKey: encodeBase64UrlCanonical(keys.signingPublicKey),
    };
}

export async function prepareE2eePasswordSignup(input: {
    origin: string;
    challenge: E2eeSignupChallenge;
    username: string;
}): Promise<PreparedE2eePasswordSignup> {
    assertE2eeOrigin(input.origin);
    assertE2eeAccountId(input.challenge.accountId);
    if (input.challenge.suite !== E2EE_SUITE) throw new Error('Unsupported E2EE signup suite');
    if (!Number.isFinite(Date.parse(input.challenge.expiresAt))
        || Date.parse(input.challenge.expiresAt) <= Date.now()) {
        throw new Error('E2EE signup challenge expired');
    }
    const normalizedUsername = input.username.trim().toLowerCase().normalize('NFC');
    if (normalizedUsername.length < 3 || normalizedUsername.length > 64) {
        throw new Error('Invalid E2EE username');
    }

    const hierarchy = generateInitialE2eeKeyHierarchy();
    const deviceKeys = await generateControlDeviceKeyPairs();
    const device = devicePublicInput(randomUUID(), deviceKeys);
    const authority = await deriveRecoveryAuthorityKeyPair(hierarchy.recoveryAuthoritySeed);
    const content = await deriveEpochContentKeyPair(hierarchy.keyring.epochs[0].secret, 1);
    try {
        const recoveryAuthorityPublicKey = encodeBase64UrlCanonical(authority.publicKey);
        const contentPublicKey = encodeBase64UrlCanonical(content.publicKey);
        const [recoveryCode, recoveryCapsule, rootEnvelope, contentKeySignature] = await Promise.all([
            encodeE2eeRecoveryCode(hierarchy.recoveryRootKey),
            createRecoveryKeyringCapsule({
                origin: input.origin,
                accountId: input.challenge.accountId,
                recoveryRootKey: hierarchy.recoveryRootKey,
                recoveryAuthoritySeed: hierarchy.recoveryAuthoritySeed,
                keyring: hierarchy.keyring,
            }),
            createControlDeviceRootEnvelope({
                origin: input.origin,
                accountId: input.challenge.accountId,
                deviceId: device.id,
                recipientEncryptionPublicKey: deviceKeys.encryptionPublicKey,
                keyring: hierarchy.keyring,
                authorizer: {
                    kind: 'recovery',
                    recoveryAuthoritySeed: hierarchy.recoveryAuthoritySeed,
                },
            }),
            signEpochContentKey({
                origin: input.origin,
                accountId: input.challenge.accountId,
                epoch: 1,
                contentPublicKey: content.publicKey,
                recoveryAuthoritySeed: hierarchy.recoveryAuthoritySeed,
            }),
        ]);
        const signupProof = await signFlatTranscript({
            accountId: input.challenge.accountId,
            capability: E2EE_CONTROL_CAPABILITY,
            contentPublicKey,
            deviceEncryptionPublicKey: device.encryptionPublicKey,
            deviceId: device.id,
            deviceSigningPublicKey: device.signingPublicKey,
            deviceType: device.type,
            domain: 'very-happy/vh-e2ee-1/signup',
            epoch: 1,
            normalizedIdentity: normalizedUsername,
            origin: input.origin,
            provider: 'password',
            recoveryAuthorityPublicKey,
            recoveryCiphertextHash: await sha256Base64Url(
                serializeRecoveryKeyringCapsule(recoveryCapsule),
            ),
            rootEnvelopeCiphertextHash: await sha256Base64Url(jcsCanonicalize(rootEnvelope)),
            signupNonce: input.challenge.nonce,
            suite: E2EE_SUITE,
        }, authority.privateKey);
        return {
            origin: input.origin,
            accountId: input.challenge.accountId,
            signupNonce: input.challenge.nonce,
            normalizedUsername,
            recoveryCode,
            recoveryAuthorityPublicKey,
            contentPublicKey,
            contentKeySignature,
            recoveryCapsule,
            device,
            rootEnvelope,
            signupProof,
            keyring: {
                currentEpoch: 1,
                epochs: hierarchy.keyring.epochs.map((item) => ({
                    epoch: item.epoch,
                    secret: item.secret.slice(),
                })),
            },
            deviceKeys,
        };
    } catch (error) {
        disposeControlDeviceKeys(deviceKeys);
        throw error;
    } finally {
        hierarchy.recoveryRootKey.fill(0);
        hierarchy.recoveryAuthoritySeed.fill(0);
        hierarchy.keyring.epochs.forEach((item) => item.secret.fill(0));
        authority.privateKey.fill(0);
        content.privateKey.fill(0);
    }
}

export async function prepareE2eeDeviceActivation(input: {
    pending: PendingE2eeDeviceLogin;
    recoveryCode: string;
}): Promise<PreparedE2eeDeviceActivation> {
    const recoveryRootKey = await decodeE2eeRecoveryCode(input.recoveryCode);
    let opened: Awaited<ReturnType<typeof openRecoveryKeyringCapsule>> | undefined;
    try {
        opened = await openRecoveryKeyringCapsule({
            capsule: input.pending.recoveryCapsule,
            recoveryRootKey,
            expectedOrigin: input.pending.origin,
            expectedAccountId: input.pending.accountId,
            expectedRecoveryAuthorityPublicKey: input.pending.recoveryAuthorityPublicKey,
            highestKnownEpoch: input.pending.cryptoEpoch,
        });
        if (opened.keyring.currentEpoch !== input.pending.cryptoEpoch) {
            throw new Error('Recovery keyring epoch does not match login');
        }
        const rootEnvelope = await createControlDeviceRootEnvelope({
            origin: input.pending.origin,
            accountId: input.pending.accountId,
            deviceId: input.pending.deviceId,
            recipientEncryptionPublicKey: input.pending.deviceKeys.encryptionPublicKey,
            keyring: opened.keyring,
            authorizer: {
                kind: 'recovery',
                recoveryAuthoritySeed: opened.recoveryAuthoritySeed,
            },
        });
        const authority = await deriveRecoveryAuthorityKeyPair(opened.recoveryAuthoritySeed);
        try {
            const activationProof = await signFlatTranscript({
                accountId: input.pending.accountId,
                authorizerKind: 'recovery',
                capability: E2EE_CONTROL_CAPABILITY,
                challenge: await sha256Base64Url(input.pending.token),
                deviceEncryptionPublicKey: input.pending.device.encryptionPublicKey,
                deviceId: input.pending.device.id,
                deviceSigningPublicKey: input.pending.device.signingPublicKey,
                deviceType: input.pending.device.type,
                domain: 'very-happy/vh-e2ee-1/device-root-envelope',
                envelopeHash: await sha256Base64Url(jcsCanonicalize(rootEnvelope)),
                epoch: input.pending.cryptoEpoch,
                origin: input.pending.origin,
                suite: E2EE_SUITE,
            }, authority.privateKey);
            return {
                rootEnvelope,
                activationProof,
                keyring: {
                    currentEpoch: opened.keyring.currentEpoch,
                    epochs: opened.keyring.epochs.map((item) => ({
                        epoch: item.epoch,
                        secret: item.secret.slice(),
                    })),
                },
            };
        } finally {
            authority.privateKey.fill(0);
        }
    } finally {
        recoveryRootKey.fill(0);
        opened?.recoveryAuthoritySeed.fill(0);
        opened?.keyring.epochs.forEach((item) => item.secret.fill(0));
    }
}

export function disposeControlDeviceKeys(keys: ControlDeviceKeyPairs): void {
    keys.encryptionPrivateKey.fill(0);
    keys.signingPrivateKey.fill(0);
    keys.encryptionPublicKey.fill(0);
    keys.signingPublicKey.fill(0);
}

export function disposePreparedE2eeSignup(prepared: PreparedE2eePasswordSignup): void {
    prepared.keyring.epochs.forEach((item) => item.secret.fill(0));
    disposeControlDeviceKeys(prepared.deviceKeys);
}
