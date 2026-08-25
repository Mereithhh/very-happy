import { describe, expect, it } from 'vitest';
import {
    E2eeIndexedDbKeyVault,
    type E2eeVaultStorage,
} from './e2eeVault';
import {
    deriveEpochContentKeyPair,
    deriveRecoveryAuthorityKeyPair,
    signEpochContentKey,
} from './e2eeKeyHierarchy';
import { loadE2eeRuntimeKeys } from './e2eeRuntime';
import { encodeBase64UrlCanonical } from '@/sync/encryption/e2eeEncoding';
import type { E2eeAuthCredentials } from './tokenStorage';

class MemoryVaultStorage implements E2eeVaultStorage {
    readonly values = new Map<string, unknown>();
    async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
    async update<T>(key: string, updater: (value: T | undefined) => T): Promise<void> {
        this.values.set(key, updater(this.values.get(key) as T | undefined));
    }
    async del(key: string): Promise<void> { this.values.delete(key); }
}

async function fixture(storage: E2eeVaultStorage): Promise<E2eeAuthCredentials> {
    const epochSecret = new Uint8Array(32).fill(31);
    const authoritySeed = new Uint8Array(32).fill(41);
    const content = await deriveEpochContentKeyPair(epochSecret, 1);
    const authority = await deriveRecoveryAuthorityKeyPair(authoritySeed);
    const credentials: E2eeAuthCredentials = {
        version: 2,
        token: 'token',
        origin: 'https://happy.example',
        accountId: 'account_1',
        deviceId: 'device_1',
        cryptoMode: 'e2ee-v1',
        e2eeProtocol: 'vh-e2ee-1',
        cryptoEpoch: 1,
        recoveryAuthorityPublicKey: encodeBase64UrlCanonical(authority.publicKey),
        contentPublicKey: encodeBase64UrlCanonical(content.publicKey),
        contentKeySignature: await signEpochContentKey({
            origin: 'https://happy.example',
            accountId: 'account_1',
            epoch: 1,
            contentPublicKey: content.publicKey,
            recoveryAuthoritySeed: authoritySeed,
        }),
    };
    const vault = new E2eeIndexedDbKeyVault(storage);
    await vault.storeKeyring({
        origin: credentials.origin,
        accountId: credentials.accountId,
        deviceId: credentials.deviceId,
    }, { currentEpoch: 1, epochs: [{ epoch: 1, secret: epochSecret }] });
    await vault.storeControlDevicePrivateKeys({
        origin: credentials.origin,
        accountId: credentials.accountId,
        deviceId: credentials.deviceId,
    }, {
        encryptionPrivateKey: new Uint8Array(32).fill(1),
        signingPrivateKey: new Uint8Array(64).fill(2),
    });
    return credentials;
}

describe('E2EE runtime unlock', () => {
    it('loads only a vault whose epoch, derived content key, and authority signature match auth', async () => {
        const storage = new MemoryVaultStorage();
        const credentials = await fixture(storage);
        const runtime = await loadE2eeRuntimeKeys(credentials, storage);
        expect(runtime.keyring.currentEpoch).toBe(1);
        expect(runtime.deviceKeys.encryptionPrivateKey).toEqual(new Uint8Array(32).fill(1));

        await expect(loadE2eeRuntimeKeys({
            ...credentials,
            contentPublicKey: encodeBase64UrlCanonical(new Uint8Array(32).fill(99)),
        }, storage)).rejects.toMatchObject({ code: 'key-context-mismatch' });
    });

    it('reports a missing vault as locked without synthesizing legacy keys', async () => {
        const storage = new MemoryVaultStorage();
        const credentials = await fixture(new MemoryVaultStorage());
        await expect(loadE2eeRuntimeKeys(credentials, storage)).rejects.toMatchObject({
            code: 'missing-local-keys',
        });
    });
});
