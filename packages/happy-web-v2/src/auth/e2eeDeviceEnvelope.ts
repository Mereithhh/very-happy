import sodium from '@/encryption/libsodium.lib';
import {
    ControlDeviceRootEnvelopeV1Schema,
    E2EE_CONTROL_DEVICE_ROOT_ENVELOPE_DOMAIN,
    E2EE_PROTOCOL_VERSION,
    E2EE_SUITE_V1,
    controlDeviceRootEnvelopeSignatureTranscript,
    type ControlDeviceRootEnvelopeV1,
} from '@slopus/happy-wire';
import {
    E2EE_SECRET_BYTES,
    deriveRecoveryAuthorityKeyPair,
    type E2eeEpochSecret,
} from './e2eeKeyHierarchy';
import type { E2eeEpochKeyring } from './e2eeRecoveryCapsule';
import {
    decodeBase64UrlCanonical,
    E2EE_DOMAIN_PREFIX,
    E2EE_SUITE,
    encodeBase64UrlCanonical,
    secureRandomBytes,
    utf8,
    utf8String,
} from '@/sync/encryption/e2eeEncoding';
import {
    assertE2eeAccountId,
    assertE2eeDeviceId,
    assertE2eeEpoch,
    assertE2eeOrigin,
} from '@/sync/encryption/e2eeContext';
import { jcsCanonicalize, parseCanonicalJcs } from '@/sync/encryption/e2eeJcs';

const DEVICE_KEYRING_DOMAIN = `${E2EE_DOMAIN_PREFIX}/control-device-keyring` as const;
const BOX_NONCE_BYTES = 24;
const BOX_TAG_BYTES = 16;
const MAX_DEVICE_ENVELOPE_BYTES = 128 * 1024;
const MAX_KEYRING_EPOCHS = 128;

export interface ControlDeviceKeyPairs {
    encryptionPublicKey: Uint8Array;
    encryptionPrivateKey: Uint8Array;
    signingPublicKey: Uint8Array;
    signingPrivateKey: Uint8Array;
}

export type RootEnvelopeAuthorizer =
    | { kind: 'recovery'; recoveryAuthoritySeed: Uint8Array }
    | { kind: 'device'; deviceId: string; signingPrivateKey: Uint8Array };

type RandomBytes = (length: number) => Uint8Array;

function randomSeed(randomBytes: RandomBytes): Uint8Array {
    const seed = randomBytes(E2EE_SECRET_BYTES);
    if (seed.length !== E2EE_SECRET_BYTES) throw new Error('Random source returned the wrong byte count');
    return seed.slice();
}

export async function deriveControlDeviceKeyPairs(input: {
    encryptionSeed: Uint8Array;
    signingSeed: Uint8Array;
}): Promise<ControlDeviceKeyPairs> {
    if (input.encryptionSeed.length !== E2EE_SECRET_BYTES
        || input.signingSeed.length !== E2EE_SECRET_BYTES) {
        throw new Error('Control device seeds must be 32 bytes');
    }
    await sodium.ready;
    const encryption = sodium.crypto_box_seed_keypair(input.encryptionSeed);
    const signing = sodium.crypto_sign_seed_keypair(input.signingSeed);
    return {
        encryptionPublicKey: encryption.publicKey.slice(),
        encryptionPrivateKey: encryption.privateKey.slice(),
        signingPublicKey: signing.publicKey.slice(),
        signingPrivateKey: signing.privateKey.slice(),
    };
}

export async function generateControlDeviceKeyPairs(
    randomBytes: RandomBytes = secureRandomBytes,
): Promise<ControlDeviceKeyPairs> {
    const encryptionSeed = randomSeed(randomBytes);
    const signingSeed = randomSeed(randomBytes);
    try {
        return await deriveControlDeviceKeyPairs({ encryptionSeed, signingSeed });
    } finally {
        encryptionSeed.fill(0);
        signingSeed.fill(0);
    }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
    const actual = Object.keys(record).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        throw new Error('Unexpected control device keyring fields');
    }
}

function validateKeyring(keyring: E2eeEpochKeyring): E2eeEpochKeyring {
    assertE2eeEpoch(keyring.currentEpoch);
    if (!Array.isArray(keyring.epochs) || keyring.epochs.length < 1
        || keyring.epochs.length > MAX_KEYRING_EPOCHS) {
        throw new Error('Invalid control device keyring size');
    }
    let previous = 0;
    let hasCurrent = false;
    for (const item of keyring.epochs) {
        assertE2eeEpoch(item.epoch);
        if (item.epoch <= previous || item.epoch > keyring.currentEpoch) {
            throw new Error('Control device keyring epochs must be unique and sorted');
        }
        if (!(item.secret instanceof Uint8Array) || item.secret.length !== E2EE_SECRET_BYTES) {
            throw new Error('Epoch secret must be 32 bytes');
        }
        previous = item.epoch;
        hasCurrent ||= item.epoch === keyring.currentEpoch;
    }
    if (!hasCurrent) throw new Error('Control device keyring lacks current epoch');
    return {
        currentEpoch: keyring.currentEpoch,
        epochs: keyring.epochs.map((item) => ({ epoch: item.epoch, secret: item.secret.slice() })),
    };
}

async function authorizerPrivateKey(authorizer: RootEnvelopeAuthorizer): Promise<{
    wire: ControlDeviceRootEnvelopeV1['authorizer'];
    privateKey: Uint8Array;
}> {
    if (authorizer.kind === 'recovery') {
        const authority = await deriveRecoveryAuthorityKeyPair(authorizer.recoveryAuthoritySeed);
        return { wire: { kind: 'recovery' }, privateKey: authority.privateKey };
    }
    assertE2eeDeviceId(authorizer.deviceId);
    if (authorizer.signingPrivateKey.length !== 64) {
        throw new Error('Control device signing private key must be 64 bytes');
    }
    return {
        wire: { kind: 'device', deviceId: authorizer.deviceId },
        privateKey: authorizer.signingPrivateKey.slice(),
    };
}

export async function createControlDeviceRootEnvelope(input: {
    origin: string;
    accountId: string;
    deviceId: string;
    recipientEncryptionPublicKey: Uint8Array;
    keyring: E2eeEpochKeyring;
    authorizer: RootEnvelopeAuthorizer;
    ephemeralSeed?: Uint8Array;
    nonce?: Uint8Array;
}): Promise<ControlDeviceRootEnvelopeV1> {
    assertE2eeOrigin(input.origin);
    assertE2eeAccountId(input.accountId);
    assertE2eeDeviceId(input.deviceId);
    if (input.recipientEncryptionPublicKey.length !== 32) {
        throw new Error('Control device encryption public key must be 32 bytes');
    }
    if (input.ephemeralSeed !== undefined && input.ephemeralSeed.length !== 32) {
        throw new Error('Ephemeral X25519 seed must be 32 bytes');
    }
    const keyring = validateKeyring(input.keyring);
    const nonce = (input.nonce ?? secureRandomBytes(BOX_NONCE_BYTES)).slice();
    if (nonce.length !== BOX_NONCE_BYTES) throw new Error('Control device envelope nonce must be 24 bytes');
    await sodium.ready;
    const ephemeral = input.ephemeralSeed
        ? sodium.crypto_box_seed_keypair(input.ephemeralSeed)
        : sodium.crypto_box_keypair();
    const plaintext = utf8(jcsCanonicalize({
        accountId: input.accountId,
        currentEpoch: keyring.currentEpoch,
        deviceId: input.deviceId,
        domain: DEVICE_KEYRING_DOMAIN,
        epochs: keyring.epochs.map((item) => ({
            epoch: item.epoch,
            secret: encodeBase64UrlCanonical(item.secret),
        })),
        origin: input.origin,
        suite: E2EE_SUITE,
        v: 1,
    }));
    let signer: Awaited<ReturnType<typeof authorizerPrivateKey>> | undefined;
    try {
        const ciphertext = sodium.crypto_box_easy(
            plaintext,
            nonce,
            input.recipientEncryptionPublicKey,
            ephemeral.privateKey,
        );
        signer = await authorizerPrivateKey(input.authorizer);
        const unsigned = {
            v: E2EE_PROTOCOL_VERSION,
            domain: E2EE_CONTROL_DEVICE_ROOT_ENVELOPE_DOMAIN,
            suite: E2EE_SUITE_V1,
            origin: input.origin,
            accountId: input.accountId,
            deviceId: input.deviceId,
            keyEpoch: keyring.currentEpoch,
            ephemeralPublicKey: encodeBase64UrlCanonical(ephemeral.publicKey),
            nonce: encodeBase64UrlCanonical(nonce),
            ciphertext: encodeBase64UrlCanonical(ciphertext),
            authorizer: signer.wire,
        };
        const signature = sodium.crypto_sign_detached(
            controlDeviceRootEnvelopeSignatureTranscript(unsigned),
            signer.privateKey,
        );
        return ControlDeviceRootEnvelopeV1Schema.parse({
            ...unsigned,
            signature: encodeBase64UrlCanonical(signature),
        });
    } finally {
        plaintext.fill(0);
        ephemeral.privateKey.fill(0);
        signer?.privateKey.fill(0);
        keyring.epochs.forEach((item) => item.secret.fill(0));
    }
}

export async function openControlDeviceRootEnvelope(input: {
    envelope: ControlDeviceRootEnvelopeV1;
    recipientEncryptionPrivateKey: Uint8Array;
    authorizerSigningPublicKey: Uint8Array;
    expectedOrigin: string;
    expectedAccountId: string;
    expectedDeviceId: string;
    expectedAuthorizer: ControlDeviceRootEnvelopeV1['authorizer'];
    highestKnownEpoch?: number;
}): Promise<E2eeEpochKeyring> {
    const envelope = ControlDeviceRootEnvelopeV1Schema.parse(input.envelope);
    assertE2eeOrigin(input.expectedOrigin);
    assertE2eeAccountId(input.expectedAccountId);
    assertE2eeDeviceId(input.expectedDeviceId);
    if (envelope.origin !== input.expectedOrigin || envelope.accountId !== input.expectedAccountId
        || envelope.deviceId !== input.expectedDeviceId) {
        throw new Error('Control device root envelope context does not match');
    }
    if (!input.expectedAuthorizer
        || jcsCanonicalize(envelope.authorizer) !== jcsCanonicalize(input.expectedAuthorizer)) {
        throw new Error('Control device root envelope authorizer does not match');
    }
    if (input.highestKnownEpoch !== undefined) {
        assertE2eeEpoch(input.highestKnownEpoch);
        if (envelope.keyEpoch < input.highestKnownEpoch) {
            throw new Error('Control device root envelope rollback detected');
        }
    }
    if (input.recipientEncryptionPrivateKey.length !== 32) {
        throw new Error('Control device encryption private key must be 32 bytes');
    }
    if (input.authorizerSigningPublicKey.length !== 32) {
        throw new Error('Authorizer signing public key must be 32 bytes');
    }
    await sodium.ready;
    const signatureValid = sodium.crypto_sign_verify_detached(
        decodeBase64UrlCanonical(envelope.signature, { exactBytes: 64 }),
        controlDeviceRootEnvelopeSignatureTranscript(envelope),
        input.authorizerSigningPublicKey,
    );
    if (!signatureValid) throw new Error('Control device root envelope signature is invalid');

    let plaintext: Uint8Array;
    try {
        plaintext = sodium.crypto_box_open_easy(
            decodeBase64UrlCanonical(envelope.ciphertext, {
                minBytes: BOX_TAG_BYTES,
                maxBytes: MAX_DEVICE_ENVELOPE_BYTES,
            }),
            decodeBase64UrlCanonical(envelope.nonce, { exactBytes: BOX_NONCE_BYTES }),
            decodeBase64UrlCanonical(envelope.ephemeralPublicKey, { exactBytes: 32 }),
            input.recipientEncryptionPrivateKey,
        );
    } catch {
        throw new Error('Control device root envelope authentication failed');
    }
    let parsed: unknown;
    try {
        parsed = parseCanonicalJcs(utf8String(plaintext), MAX_DEVICE_ENVELOPE_BYTES);
    } finally {
        plaintext.fill(0);
    }
    if (!isPlainRecord(parsed)) throw new Error('Invalid control device keyring');
    assertExactKeys(parsed, [
        'v', 'domain', 'suite', 'origin', 'accountId', 'deviceId', 'currentEpoch', 'epochs',
    ]);
    if (parsed.v !== 1 || parsed.domain !== DEVICE_KEYRING_DOMAIN || parsed.suite !== E2EE_SUITE
        || parsed.origin !== envelope.origin || parsed.accountId !== envelope.accountId
        || parsed.deviceId !== envelope.deviceId || parsed.currentEpoch !== envelope.keyEpoch
        || !Array.isArray(parsed.epochs)) {
        throw new Error('Control device keyring context does not match');
    }
    const decodedEpochs: E2eeEpochSecret[] = [];
    try {
        for (const item of parsed.epochs) {
            if (!isPlainRecord(item)) throw new Error('Invalid control device keyring epoch');
            assertExactKeys(item, ['epoch', 'secret']);
            if (typeof item.epoch !== 'number' || typeof item.secret !== 'string') {
                throw new Error('Invalid control device keyring epoch');
            }
            decodedEpochs.push({
                epoch: item.epoch,
                secret: decodeBase64UrlCanonical(item.secret, { exactBytes: E2EE_SECRET_BYTES }),
            });
        }
        return validateKeyring({ currentEpoch: envelope.keyEpoch, epochs: decodedEpochs });
    } finally {
        decodedEpochs.forEach((item) => item.secret.fill(0));
    }
}
