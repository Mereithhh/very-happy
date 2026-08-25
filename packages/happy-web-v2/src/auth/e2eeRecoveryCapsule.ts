import sodium from '@/encryption/libsodium.lib';
import {
    E2EE_RECOVERY_CAPSULE_DOMAIN,
    E2EE_SUITE_V1,
    RecoveryKeyringCapsuleV1Schema,
    type RecoveryKeyringCapsuleV1 as WireRecoveryKeyringCapsuleV1,
} from '@slopus/happy-wire';
import {
    deriveRecoveryAuthorityKeyPair,
    E2EE_SECRET_BYTES,
    type E2eeEpochSecret,
} from './e2eeKeyHierarchy';
import {
    constantTimeEqual,
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
    assertE2eeEpoch,
    assertE2eeOrigin,
} from '@/sync/encryption/e2eeContext';
import { jcsCanonicalize, parseCanonicalJcs } from '@/sync/encryption/e2eeJcs';

const RECOVERY_NONCE_BYTES = 24;
const RECOVERY_TAG_BYTES = 16;
const MAX_CAPSULE_CIPHERTEXT_BYTES = 64 * 1024;
const MAX_KEYRING_EPOCHS = 128;
const KEYRING_DOMAIN = `${E2EE_DOMAIN_PREFIX}/recovery-keyring` as const;

export interface E2eeEpochKeyring {
    currentEpoch: number;
    epochs: E2eeEpochSecret[];
}

/** The Web recovery wrapper is exactly the frozen shared recovery wire. */
export type RecoveryKeyringCapsuleV1 = WireRecoveryKeyringCapsuleV1;

export interface OpenedRecoveryKeyring {
    recoveryAuthoritySeed: Uint8Array;
    keyring: E2eeEpochKeyring;
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
        throw new Error('Unexpected E2EE capsule fields');
    }
}

function validateEpochs(epochs: readonly E2eeEpochSecret[], currentEpoch: number): E2eeEpochSecret[] {
    assertE2eeEpoch(currentEpoch);
    if (epochs.length < 1 || epochs.length > MAX_KEYRING_EPOCHS) {
        throw new Error('Invalid E2EE keyring size');
    }
    let previous = 0;
    let hasCurrent = false;
    for (const item of epochs) {
        assertE2eeEpoch(item.epoch);
        if (item.epoch <= previous) throw new Error('E2EE keyring epochs must be unique and sorted');
        if (item.epoch > currentEpoch) throw new Error('E2EE keyring contains a future epoch');
        if (item.secret.length !== E2EE_SECRET_BYTES) throw new Error('Epoch secret must be 32 bytes');
        previous = item.epoch;
        hasCurrent ||= item.epoch === currentEpoch;
    }
    if (!hasCurrent) throw new Error('E2EE keyring lacks current epoch');
    return epochs.map((item) => ({ epoch: item.epoch, secret: item.secret.slice() }));
}

function capsuleSignatureTranscript(capsule: Omit<RecoveryKeyringCapsuleV1, 'signature'>): Uint8Array {
    return utf8(jcsCanonicalize(capsule));
}

function validateCapsule(value: unknown): RecoveryKeyringCapsuleV1 {
    return RecoveryKeyringCapsuleV1Schema.parse(value);
}

export async function createRecoveryKeyringCapsule(input: {
    origin: string;
    accountId: string;
    recoveryRootKey: Uint8Array;
    recoveryAuthoritySeed: Uint8Array;
    keyring: E2eeEpochKeyring;
    nonce?: Uint8Array;
}): Promise<RecoveryKeyringCapsuleV1> {
    assertE2eeOrigin(input.origin);
    assertE2eeAccountId(input.accountId);
    if (input.recoveryRootKey.length !== E2EE_SECRET_BYTES) throw new Error('RRK must be 32 bytes');
    if (input.recoveryAuthoritySeed.length !== E2EE_SECRET_BYTES) {
        throw new Error('Recovery authority seed must be 32 bytes');
    }
    const epochs = validateEpochs(input.keyring.epochs, input.keyring.currentEpoch);
    const nonce = (input.nonce ?? secureRandomBytes(RECOVERY_NONCE_BYTES)).slice();
    if (nonce.length !== RECOVERY_NONCE_BYTES) throw new Error('Recovery nonce must be 24 bytes');
    const plaintext = utf8(jcsCanonicalize({
        accountId: input.accountId,
        currentEpoch: input.keyring.currentEpoch,
        domain: KEYRING_DOMAIN,
        epochs: epochs.map((item) => ({
            epoch: item.epoch,
            secret: encodeBase64UrlCanonical(item.secret),
        })),
        origin: input.origin,
        recoveryAuthoritySeed: encodeBase64UrlCanonical(input.recoveryAuthoritySeed),
        suite: E2EE_SUITE,
    }));
    await sodium.ready;
    let ciphertext: Uint8Array;
    try {
        ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, input.recoveryRootKey);
    } finally {
        plaintext.fill(0);
        epochs.forEach((item) => item.secret.fill(0));
    }
    const authority = await deriveRecoveryAuthorityKeyPair(input.recoveryAuthoritySeed);
    try {
        const unsigned: Omit<RecoveryKeyringCapsuleV1, 'signature'> = {
            v: 1,
            domain: E2EE_RECOVERY_CAPSULE_DOMAIN,
            suite: E2EE_SUITE_V1,
            origin: input.origin,
            accountId: input.accountId,
            currentEpoch: input.keyring.currentEpoch,
            recoveryAuthorityPublicKey: encodeBase64UrlCanonical(authority.publicKey),
            nonce: encodeBase64UrlCanonical(nonce),
            ciphertext: encodeBase64UrlCanonical(ciphertext),
        };
        const signature = sodium.crypto_sign_detached(
            capsuleSignatureTranscript(unsigned),
            authority.privateKey,
        );
        return { ...unsigned, signature: encodeBase64UrlCanonical(signature) };
    } finally {
        authority.privateKey.fill(0);
    }
}

export async function openRecoveryKeyringCapsule(input: {
    capsule: RecoveryKeyringCapsuleV1;
    recoveryRootKey: Uint8Array;
    expectedOrigin: string;
    expectedAccountId: string;
    expectedRecoveryAuthorityPublicKey?: string;
    highestKnownEpoch?: number;
}): Promise<OpenedRecoveryKeyring> {
    const capsule = validateCapsule(input.capsule);
    assertE2eeOrigin(input.expectedOrigin);
    assertE2eeAccountId(input.expectedAccountId);
    if (capsule.origin !== input.expectedOrigin || capsule.accountId !== input.expectedAccountId) {
        throw new Error('Recovery capsule context does not match');
    }
    if (input.highestKnownEpoch !== undefined) {
        assertE2eeEpoch(input.highestKnownEpoch);
        if (capsule.currentEpoch < input.highestKnownEpoch) throw new Error('Recovery capsule rollback detected');
    }
    if (input.expectedRecoveryAuthorityPublicKey !== undefined
        && capsule.recoveryAuthorityPublicKey !== input.expectedRecoveryAuthorityPublicKey) {
        throw new Error('Recovery authority does not match');
    }
    if (input.recoveryRootKey.length !== E2EE_SECRET_BYTES) throw new Error('RRK must be 32 bytes');

    const nonce = decodeBase64UrlCanonical(capsule.nonce, { exactBytes: RECOVERY_NONCE_BYTES });
    const ciphertext = decodeBase64UrlCanonical(capsule.ciphertext, {
        minBytes: RECOVERY_TAG_BYTES,
        maxBytes: MAX_CAPSULE_CIPHERTEXT_BYTES,
    });
    await sodium.ready;
    let plaintext: Uint8Array;
    try {
        plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, input.recoveryRootKey);
    } catch {
        throw new Error('Recovery capsule authentication failed');
    }
    let parsed: unknown;
    try {
        parsed = parseCanonicalJcs(utf8String(plaintext), MAX_CAPSULE_CIPHERTEXT_BYTES);
    } finally {
        plaintext.fill(0);
    }
    if (!isPlainRecord(parsed)) throw new Error('Invalid recovery keyring');
    assertExactKeys(parsed, [
        'accountId', 'currentEpoch', 'domain', 'epochs', 'origin',
        'recoveryAuthoritySeed', 'suite',
    ]);
    if (parsed.domain !== KEYRING_DOMAIN || parsed.suite !== E2EE_SUITE
        || parsed.origin !== capsule.origin || parsed.accountId !== capsule.accountId
        || parsed.currentEpoch !== capsule.currentEpoch
        || typeof parsed.recoveryAuthoritySeed !== 'string' || !Array.isArray(parsed.epochs)) {
        throw new Error('Recovery keyring context does not match');
    }
    const authoritySeed = decodeBase64UrlCanonical(parsed.recoveryAuthoritySeed, { exactBytes: 32 });
    const epochItems: E2eeEpochSecret[] = [];
    let epochs: E2eeEpochSecret[];
    try {
        for (const item of parsed.epochs) {
            if (!isPlainRecord(item)) throw new Error('Invalid recovery keyring epoch');
            assertExactKeys(item, ['epoch', 'secret']);
            if (typeof item.epoch !== 'number' || typeof item.secret !== 'string') {
                throw new Error('Invalid recovery keyring epoch');
            }
            epochItems.push({
                epoch: item.epoch,
                secret: decodeBase64UrlCanonical(item.secret, { exactBytes: 32 }),
            });
        }
        epochs = validateEpochs(epochItems, capsule.currentEpoch);
    } catch (error) {
        authoritySeed.fill(0);
        throw error;
    } finally {
        epochItems.forEach((item) => item.secret.fill(0));
    }

    let authority: Awaited<ReturnType<typeof deriveRecoveryAuthorityKeyPair>> | undefined;
    try {
        authority = await deriveRecoveryAuthorityKeyPair(authoritySeed);
        const capsulePublicKey = decodeBase64UrlCanonical(
            capsule.recoveryAuthorityPublicKey,
            { exactBytes: 32 },
        );
        if (!constantTimeEqual(authority.publicKey, capsulePublicKey)) {
            throw new Error('Recovery authority seed does not match capsule');
        }
        const { signature, ...unsigned } = capsule;
        const validSignature = sodium.crypto_sign_verify_detached(
            decodeBase64UrlCanonical(signature, { exactBytes: 64 }),
            capsuleSignatureTranscript(unsigned),
            authority.publicKey,
        );
        if (!validSignature) throw new Error('Recovery capsule signature is invalid');
        return {
            recoveryAuthoritySeed: authoritySeed,
            keyring: { currentEpoch: capsule.currentEpoch, epochs },
        };
    } catch (error) {
        authoritySeed.fill(0);
        epochs.forEach((item) => item.secret.fill(0));
        throw error;
    } finally {
        authority?.privateKey.fill(0);
    }
}

/**
 * Canonical serialization of the complete recovery capsule, including its
 * authenticated header and signature. Network APIs carry the object itself as
 * `recoveryCapsule`; callers must never send or persist only `capsule.ciphertext`.
 */
export function serializeRecoveryKeyringCapsule(capsule: RecoveryKeyringCapsuleV1): string {
    return jcsCanonicalize(validateCapsule(capsule));
}

export function parseRecoveryKeyringCapsule(serialized: string): RecoveryKeyringCapsuleV1 {
    return validateCapsule(parseCanonicalJcs(serialized, 128 * 1024));
}
