import sodium from '@/encryption/libsodium.lib';
import { assertE2eeEpoch } from '@/sync/encryption/e2eeContext';
import {
    constantTimeEqual,
    decodeBase64UrlCanonical,
    E2EE_DOMAIN_PREFIX,
    E2EE_SUITE,
    encodeBase64UrlCanonical,
    secureRandomBytes,
    utf8,
} from '@/sync/encryption/e2eeEncoding';
import { deriveE2eeKey } from '@/sync/encryption/e2eeKdf';
import { assertE2eeAccountId, assertE2eeOrigin } from '@/sync/encryption/e2eeContext';
import { jcsCanonicalize } from '@/sync/encryption/e2eeJcs';

export const E2EE_SECRET_BYTES = 32;

export interface E2eeEpochSecret {
    epoch: number;
    secret: Uint8Array;
}

export interface InitialE2eeKeyHierarchy {
    recoveryRootKey: Uint8Array;
    recoveryAuthoritySeed: Uint8Array;
    keyring: {
        currentEpoch: 1;
        epochs: [E2eeEpochSecret];
    };
}

export interface E2eeSigningKeyPair {
    publicKey: Uint8Array;
    privateKey: Uint8Array;
}

export interface E2eeContentKeyPair {
    publicKey: Uint8Array;
    privateKey: Uint8Array;
}

type RandomBytes = (length: number) => Uint8Array;

function randomSecret(randomBytes: RandomBytes): Uint8Array {
    const result = randomBytes(E2EE_SECRET_BYTES);
    if (result.length !== E2EE_SECRET_BYTES) throw new Error('Random source returned the wrong byte count');
    return result.slice();
}

export function generateInitialE2eeKeyHierarchy(
    randomBytes: RandomBytes = secureRandomBytes,
): InitialE2eeKeyHierarchy {
    // These are deliberately three independent CSPRNG draws.  Neither the
    // recovery authority nor an epoch root is derived from the recovery code.
    const recoveryRootKey = randomSecret(randomBytes);
    const recoveryAuthoritySeed = randomSecret(randomBytes);
    const epochOne = randomSecret(randomBytes);
    return {
        recoveryRootKey,
        recoveryAuthoritySeed,
        keyring: { currentEpoch: 1, epochs: [{ epoch: 1, secret: epochOne }] },
    };
}

export async function deriveRecoveryAuthorityKeyPair(
    authoritySeed: Uint8Array,
): Promise<E2eeSigningKeyPair> {
    if (authoritySeed.length !== E2EE_SECRET_BYTES) {
        throw new Error('Recovery authority seed must be 32 bytes');
    }
    await sodium.ready;
    const pair = sodium.crypto_sign_seed_keypair(authoritySeed);
    return { publicKey: pair.publicKey.slice(), privateKey: pair.privateKey.slice() };
}

export async function deriveEpochContentKeyPair(
    epochSecret: Uint8Array,
    epoch: number,
): Promise<E2eeContentKeyPair> {
    assertE2eeEpoch(epoch);
    const seed = await deriveE2eeKey(
        epochSecret,
        `${E2EE_DOMAIN_PREFIX}/content/x25519/epoch/${epoch}`,
    );
    await sodium.ready;
    const pair = sodium.crypto_box_seed_keypair(seed);
    seed.fill(0);
    return { publicKey: pair.publicKey.slice(), privateKey: pair.privateKey.slice() };
}

export async function deriveAccountDomainKey(
    epochSecret: Uint8Array,
    epoch: number,
    domain: 'settings' | 'kv' | 'notes' | 'tasks',
): Promise<Uint8Array> {
    assertE2eeEpoch(epoch);
    return deriveE2eeKey(
        epochSecret,
        `${E2EE_DOMAIN_PREFIX}/account/${domain}/epoch/${epoch}`,
    );
}

function contentKeyTranscript(input: {
    origin: string;
    accountId: string;
    epoch: number;
    contentPublicKey: Uint8Array;
}): Uint8Array {
    assertE2eeOrigin(input.origin);
    assertE2eeAccountId(input.accountId);
    assertE2eeEpoch(input.epoch);
    if (input.contentPublicKey.length !== 32) throw new Error('Content public key must be 32 bytes');
    return utf8(jcsCanonicalize({
        accountId: input.accountId,
        contentPublicKey: encodeBase64UrlCanonical(input.contentPublicKey),
        domain: `${E2EE_DOMAIN_PREFIX}/content-key`,
        epoch: input.epoch,
        origin: input.origin,
        suite: E2EE_SUITE,
    }));
}

export async function signEpochContentKey(input: {
    origin: string;
    accountId: string;
    epoch: number;
    contentPublicKey: Uint8Array;
    recoveryAuthoritySeed: Uint8Array;
}): Promise<string> {
    const authority = await deriveRecoveryAuthorityKeyPair(input.recoveryAuthoritySeed);
    await sodium.ready;
    const signature = sodium.crypto_sign_detached(contentKeyTranscript(input), authority.privateKey);
    authority.privateKey.fill(0);
    return encodeBase64UrlCanonical(signature);
}

export async function verifyEpochContentKey(input: {
    origin: string;
    accountId: string;
    epoch: number;
    contentPublicKey: Uint8Array;
    recoveryAuthorityPublicKey: Uint8Array;
    signature: string;
}): Promise<boolean> {
    if (input.recoveryAuthorityPublicKey.length !== 32) {
        throw new Error('Recovery authority public key must be 32 bytes');
    }
    const signature = decodeBase64UrlCanonical(input.signature, { exactBytes: 64 });
    await sodium.ready;
    return sodium.crypto_sign_verify_detached(
        signature,
        contentKeyTranscript(input),
        input.recoveryAuthorityPublicKey,
    );
}

export async function verifyEpochSecretMatchesContentKey(input: {
    epochSecret: Uint8Array;
    epoch: number;
    expectedContentPublicKey: Uint8Array;
}): Promise<boolean> {
    const pair = await deriveEpochContentKeyPair(input.epochSecret, input.epoch);
    const matches = constantTimeEqual(pair.publicKey, input.expectedContentPublicKey);
    pair.privateKey.fill(0);
    return matches;
}
