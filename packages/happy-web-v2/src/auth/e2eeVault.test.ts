import { describe, expect, it } from 'vitest';
import { E2eeIndexedDbKeyVault, type E2eeVaultStorage } from './e2eeVault';
import { encodeBase64UrlCanonical } from '@/sync/encryption/e2eeEncoding';

class MemoryVaultStorage implements E2eeVaultStorage {
    readonly values = new Map<string, unknown>();
    async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
    async update<T>(key: string, updater: (value: T | undefined) => T): Promise<void> {
        this.values.set(key, updater(this.values.get(key) as T | undefined));
    }
    async del(key: string): Promise<void> { this.values.delete(key); }
}

class PausableVaultStorage extends MemoryVaultStorage {
    private pauseNextUpdate = false;
    private enteredResolve: (() => void) | null = null;
    private releaseResolve: (() => void) | null = null;
    private entered = Promise.resolve();
    private release = Promise.resolve();

    armOneUpdatePause(): void {
        this.pauseNextUpdate = true;
        this.entered = new Promise((resolve) => { this.enteredResolve = resolve; });
        this.release = new Promise((resolve) => { this.releaseResolve = resolve; });
    }

    waitUntilPaused(): Promise<void> { return this.entered; }
    resume(): void { this.releaseResolve?.(); }

    override async update<T>(key: string, updater: (value: T | undefined) => T): Promise<void> {
        if (this.pauseNextUpdate) {
            this.pauseNextUpdate = false;
            this.enteredResolve?.();
            await this.release;
        }
        return super.update(key, updater);
    }
}

const context = {
    origin: 'https://happy.example',
    accountId: 'acc_vault_1',
    deviceId: 'dev_vault_1',
};
const secret = Uint8Array.from({ length: 32 }, (_, index) => 80 + index);

describe('IndexedDB E2EE key vault', () => {
    it('stores only ciphertext behind a non-extractable wrapping key', async () => {
        const storage = new MemoryVaultStorage();
        const vault = new E2eeIndexedDbKeyVault(storage);
        await vault.storeKeyring(context, { currentEpoch: 1, epochs: [{ epoch: 1, secret }] });
        const deviceKeys = {
            encryptionPrivateKey: new Uint8Array(32).fill(31),
            signingPrivateKey: new Uint8Array(64).fill(63),
        };
        await vault.storeControlDevicePrivateKeys(context, deviceKeys);
        expect(storage.values.size).toBe(1);
        const records = [...storage.values.values()] as Array<Record<string, unknown>>;
        const key = records.find((record) => 'key' in record)?.key as CryptoKey;
        expect(key.extractable).toBe(false);
        expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
        expect(JSON.stringify(records)).not.toContain(encodeBase64UrlCanonical(secret));
        expect(JSON.stringify(records)).not.toContain(
            encodeBase64UrlCanonical(deviceKeys.encryptionPrivateKey),
        );
        expect(JSON.stringify(records)).not.toContain(
            encodeBase64UrlCanonical(deviceKeys.signingPrivateKey),
        );
        await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
        await expect(vault.loadKeyring(context)).resolves.toEqual({
            currentEpoch: 1,
            epochs: [{ epoch: 1, secret }],
        });
        await expect(vault.loadControlDevicePrivateKeys(context)).resolves.toEqual(deviceKeys);
    });

    it('rejects rollback, tampering, missing device key, and context swaps', async () => {
        const storage = new MemoryVaultStorage();
        const vault = new E2eeIndexedDbKeyVault(storage);
        await vault.storeKeyring(context, {
            currentEpoch: 2,
            epochs: [{ epoch: 1, secret }, { epoch: 2, secret: new Uint8Array(32).fill(9) }],
        });
        await expect(vault.storeKeyring(context, {
            currentEpoch: 1, epochs: [{ epoch: 1, secret }],
        })).rejects.toThrow(/roll back/);
        await expect(vault.loadKeyring(context, { highestKnownEpoch: 3 })).rejects.toThrow(/rollback/);
        await expect(vault.loadKeyring({ ...context, deviceId: 'dev_other' })).resolves.toBeNull();

        const vaultEntry = [...storage.values.entries()][0]!;
        const record = vaultEntry[1] as Record<string, unknown>;
        const wrapped = record.wrapped as Record<string, unknown>;
        storage.values.set(vaultEntry[0], {
            ...record,
            wrapped: {
                ...wrapped,
                ciphertext: `${String(wrapped.ciphertext)[0] === 'A' ? 'B' : 'A'}${String(wrapped.ciphertext).slice(1)}`,
            },
        });
        await expect(vault.loadKeyring(context)).rejects.toThrow();
    });

    it('removes both the wrapped payload and local wrapping key', async () => {
        const storage = new MemoryVaultStorage();
        const vault = new E2eeIndexedDbKeyVault(storage);
        await vault.storeKeyring(context, { currentEpoch: 1, epochs: [{ epoch: 1, secret }] });
        await vault.remove(context);
        expect(storage.values.size).toBe(0);
        await expect(vault.loadKeyring(context)).resolves.toBeNull();
    });

    it('keeps a valid monotonic record across concurrent tab-like updates', async () => {
        const storage = new MemoryVaultStorage();
        const firstTab = new E2eeIndexedDbKeyVault(storage);
        const secondTab = new E2eeIndexedDbKeyVault(storage);
        const results = await Promise.allSettled([
            firstTab.storeKeyring(context, {
                currentEpoch: 1,
                epochs: [{ epoch: 1, secret }],
            }),
            secondTab.storeKeyring(context, {
                currentEpoch: 2,
                epochs: [{ epoch: 1, secret }, { epoch: 2, secret: new Uint8Array(32).fill(22) }],
            }),
        ]);
        // Depending on scheduling, the epoch-1 writer either lands first or is
        // rejected after epoch 2.  It must never overwrite epoch 2.
        expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
        const loaded = await firstTab.loadKeyring(context);
        expect(loaded?.currentEpoch).toBe(2);
        expect(loaded?.epochs[1].secret).toEqual(new Uint8Array(32).fill(22));
    });

    it('re-encrypts with the replacement generation after remove/recreate races an old writer', async () => {
        const storage = new PausableVaultStorage();
        const oldTab = new E2eeIndexedDbKeyVault(storage);
        const newTab = new E2eeIndexedDbKeyVault(storage);
        await oldTab.storeKeyring(context, { currentEpoch: 1, epochs: [{ epoch: 1, secret }] });

        storage.armOneUpdatePause();
        const oldWrite = oldTab.storeKeyring(context, {
            currentEpoch: 2,
            epochs: [{ epoch: 1, secret }, { epoch: 2, secret: new Uint8Array(32).fill(44) }],
        });
        await storage.waitUntilPaused();

        await newTab.remove(context);
        await newTab.storeKeyring(context, { currentEpoch: 1, epochs: [{ epoch: 1, secret }] });
        storage.resume();
        await oldWrite;

        await expect(newTab.loadKeyring(context)).resolves.toEqual({
            currentEpoch: 2,
            epochs: [{ epoch: 1, secret }, { epoch: 2, secret: new Uint8Array(32).fill(44) }],
        });
    });
});
