import type { E2eeAuthCredentials } from './tokenStorage';
import {
    E2eeIndexedDbKeyVault,
    type E2eeControlDevicePrivateKeys,
    type E2eeVaultStorage,
} from './e2eeVault';
import type { E2eeEpochKeyring } from './e2eeRecoveryCapsule';
import {
    deriveEpochContentKeyPair,
    verifyEpochContentKey,
    verifyEpochSecretMatchesContentKey,
} from './e2eeKeyHierarchy';
import { decodeBase64UrlCanonical } from '@/sync/encryption/e2eeEncoding';

export type E2eeUnlockErrorCode = 'missing-local-keys' | 'vault-auth-failed' | 'key-context-mismatch';

export class E2eeUnlockError extends Error {
    constructor(readonly code: E2eeUnlockErrorCode, message: string) {
        super(message);
        this.name = 'E2eeUnlockError';
    }
}

export interface E2eeRuntimeKeys {
    credentials: E2eeAuthCredentials;
    keyring: E2eeEpochKeyring;
    deviceKeys: E2eeControlDevicePrivateKeys;
}

export async function loadE2eeRuntimeKeys(
    credentials: E2eeAuthCredentials,
    storage?: E2eeVaultStorage,
): Promise<E2eeRuntimeKeys> {
    const vault = new E2eeIndexedDbKeyVault(storage);
    const context = {
        origin: credentials.origin,
        accountId: credentials.accountId,
        deviceId: credentials.deviceId,
    };
    let keyring: E2eeEpochKeyring | null;
    let deviceKeys: E2eeControlDevicePrivateKeys | null;
    try {
        [keyring, deviceKeys] = await Promise.all([
            vault.loadKeyring(context, { highestKnownEpoch: credentials.cryptoEpoch }),
            vault.loadControlDevicePrivateKeys(context),
        ]);
    } catch (error) {
        throw new E2eeUnlockError('vault-auth-failed', 'Local E2EE vault authentication failed');
    }
    if (!keyring || !deviceKeys) {
        throw new E2eeUnlockError('missing-local-keys', 'This E2EE device is locked');
    }
    if (keyring.currentEpoch !== credentials.cryptoEpoch) {
        disposeE2eeRuntimeKeys({ credentials, keyring, deviceKeys });
        throw new E2eeUnlockError('key-context-mismatch', 'Local and authenticated E2EE epochs differ');
    }
    const current = keyring.epochs.find((item) => item.epoch === credentials.cryptoEpoch);
    if (!current) {
        disposeE2eeRuntimeKeys({ credentials, keyring, deviceKeys });
        throw new E2eeUnlockError('key-context-mismatch', 'Current E2EE epoch is absent');
    }
    try {
        const contentPublicKey = decodeBase64UrlCanonical(credentials.contentPublicKey, { exactBytes: 32 });
        const authorityPublicKey = decodeBase64UrlCanonical(
            credentials.recoveryAuthorityPublicKey,
            { exactBytes: 32 },
        );
        const [secretMatches, signatureValid] = await Promise.all([
            verifyEpochSecretMatchesContentKey({
                epochSecret: current.secret,
                epoch: credentials.cryptoEpoch,
                expectedContentPublicKey: contentPublicKey,
            }),
            verifyEpochContentKey({
                origin: credentials.origin,
                accountId: credentials.accountId,
                epoch: credentials.cryptoEpoch,
                contentPublicKey,
                recoveryAuthorityPublicKey: authorityPublicKey,
                signature: credentials.contentKeySignature,
            }),
        ]);
        if (!secretMatches || !signatureValid) {
            throw new E2eeUnlockError('key-context-mismatch', 'Authenticated E2EE key context does not match vault');
        }
        return { credentials, keyring, deviceKeys };
    } catch (error) {
        disposeE2eeRuntimeKeys({ credentials, keyring, deviceKeys });
        if (error instanceof E2eeUnlockError) throw error;
        throw new E2eeUnlockError('key-context-mismatch', 'Authenticated E2EE key context is invalid');
    }
}

export function disposeE2eeRuntimeKeys(runtime: E2eeRuntimeKeys): void {
    runtime.keyring.epochs.forEach((item) => item.secret.fill(0));
    runtime.deviceKeys.encryptionPrivateKey.fill(0);
    runtime.deviceKeys.signingPrivateKey.fill(0);
}

/** Derive a content pair without exposing an epoch secret to callers. */
export async function deriveRuntimeContentKeyPair(runtime: E2eeRuntimeKeys, epoch: number) {
    const item = runtime.keyring.epochs.find((candidate) => candidate.epoch === epoch);
    if (!item) throw new E2eeUnlockError('key-context-mismatch', `Unknown E2EE epoch ${epoch}`);
    return deriveEpochContentKeyPair(item.secret, epoch);
}
