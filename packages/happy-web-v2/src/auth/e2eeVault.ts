import {
    createStore,
    del as idbDel,
    get as idbGet,
    update as idbUpdate,
    type UseStore,
} from 'idb-keyval';
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

const VAULT_KEY_DOMAIN = `${E2EE_DOMAIN_PREFIX}/local-wrapping-key` as const;
const VAULT_PAYLOAD_DOMAIN = `${E2EE_DOMAIN_PREFIX}/local-keyring` as const;
const VAULT_DEVICE_KEYS_DOMAIN = `${E2EE_DOMAIN_PREFIX}/local-control-device-keys` as const;
const MAX_VAULT_PLAINTEXT_BYTES = 64 * 1024;
const MAX_KEYRING_EPOCHS = 128;
const VAULT_GENERATION_BYTES = 16;
const MAX_VAULT_WRITE_RETRIES = 4;

export interface E2eeVaultStorage {
    get<T>(key: string): Promise<T | undefined>;
    update<T>(key: string, updater: (value: T | undefined) => T): Promise<void>;
    del(key: string): Promise<void>;
}

interface VaultRecordV1 {
    v: 1;
    domain: typeof VAULT_KEY_DOMAIN;
    suite: typeof E2EE_SUITE;
    origin: string;
    accountId: string;
    deviceId: string;
    generation: string;
    key: CryptoKey;
    wrapped: {
        currentEpoch: number;
        nonce: string;
        ciphertext: string;
    } | null;
    wrappedDeviceKeys: {
        nonce: string;
        ciphertext: string;
    } | null;
}

export interface E2eeControlDevicePrivateKeys {
    encryptionPrivateKey: Uint8Array;
    signingPrivateKey: Uint8Array;
}

export interface E2eeVaultContext {
    origin: string;
    accountId: string;
    deviceId: string;
}

const defaultIdbStore: UseStore = createStore('very-happy-e2ee-v1', 'key-vault');

export const e2eeIndexedDbStorage: E2eeVaultStorage = {
    get: <T>(key: string) => idbGet<T>(key, defaultIdbStore),
    update: <T>(key: string, updater: (value: T | undefined) => T) => idbUpdate(key, updater, defaultIdbStore),
    del: (key: string) => idbDel(key, defaultIdbStore),
};

function validateContext(context: E2eeVaultContext): void {
    assertE2eeOrigin(context.origin);
    assertE2eeAccountId(context.accountId);
    assertE2eeDeviceId(context.deviceId);
}

function storagePrefix(context: E2eeVaultContext): string {
    validateContext(context);
    return `vh-e2ee-1:${encodeURIComponent(context.origin)}:${context.accountId}:${context.deviceId}`;
}

function vaultStorageKey(context: E2eeVaultContext): string {
    return `${storagePrefix(context)}:vault`;
}

function vaultAad(context: E2eeVaultContext, currentEpoch: number): Uint8Array {
    validateContext(context);
    assertE2eeEpoch(currentEpoch);
    return utf8(jcsCanonicalize({
        accountId: context.accountId,
        currentEpoch,
        deviceId: context.deviceId,
        domain: VAULT_PAYLOAD_DOMAIN,
        origin: context.origin,
        suite: E2EE_SUITE,
        v: 1,
    }));
}

function deviceKeysAad(context: E2eeVaultContext): Uint8Array {
    validateContext(context);
    return utf8(jcsCanonicalize({
        accountId: context.accountId,
        deviceId: context.deviceId,
        domain: VAULT_DEVICE_KEYS_DOMAIN,
        origin: context.origin,
        suite: E2EE_SUITE,
        v: 1,
    }));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isNonExtractableAesKey(value: unknown): value is CryptoKey {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as CryptoKey;
    const algorithm = candidate.algorithm as AesKeyAlgorithm | undefined;
    return candidate.type === 'secret'
        && candidate.extractable === false
        && algorithm?.name === 'AES-GCM'
        && algorithm.length === 256
        && candidate.usages.includes('encrypt')
        && candidate.usages.includes('decrypt');
}

function validateKeyring(keyring: E2eeEpochKeyring): E2eeEpochKeyring {
    assertE2eeEpoch(keyring.currentEpoch);
    if (!Array.isArray(keyring.epochs) || keyring.epochs.length < 1
        || keyring.epochs.length > MAX_KEYRING_EPOCHS) {
        throw new Error('Invalid vault keyring size');
    }
    let previous = 0;
    let foundCurrent = false;
    for (const item of keyring.epochs) {
        assertE2eeEpoch(item.epoch);
        if (item.epoch <= previous || item.epoch > keyring.currentEpoch) {
            throw new Error('Vault keyring epochs must be sorted and unique');
        }
        if (!(item.secret instanceof Uint8Array) || item.secret.length !== 32) {
            throw new Error('Vault epoch secret must be 32 bytes');
        }
        previous = item.epoch;
        foundCurrent ||= item.epoch === keyring.currentEpoch;
    }
    if (!foundCurrent) throw new Error('Vault keyring lacks current epoch');
    return {
        currentEpoch: keyring.currentEpoch,
        epochs: keyring.epochs.map((item) => ({ epoch: item.epoch, secret: item.secret.slice() })),
    };
}

function validateVaultRecord(value: unknown, context: E2eeVaultContext): VaultRecordV1 {
    if (!isPlainRecord(value)
        || !exactKeys(value, [
            'v', 'domain', 'suite', 'origin', 'accountId', 'deviceId',
            'generation', 'key', 'wrapped', 'wrappedDeviceKeys',
        ])
        || value.v !== 1 || value.domain !== VAULT_KEY_DOMAIN || value.suite !== E2EE_SUITE
        || value.origin !== context.origin || value.accountId !== context.accountId
        || value.deviceId !== context.deviceId || !isNonExtractableAesKey(value.key)) {
        throw new Error('Invalid local E2EE wrapping key');
    }
    if (typeof value.generation !== 'string') throw new Error('Invalid local E2EE vault generation');
    decodeBase64UrlCanonical(value.generation, { exactBytes: VAULT_GENERATION_BYTES });
    if (value.wrapped !== null) {
        if (!isPlainRecord(value.wrapped)
            || !exactKeys(value.wrapped, ['currentEpoch', 'nonce', 'ciphertext'])
            || typeof value.wrapped.currentEpoch !== 'number'
            || typeof value.wrapped.nonce !== 'string'
            || typeof value.wrapped.ciphertext !== 'string') {
            throw new Error('Invalid wrapped E2EE keyring');
        }
        assertE2eeEpoch(value.wrapped.currentEpoch);
        decodeBase64UrlCanonical(value.wrapped.nonce, { exactBytes: 12 });
        decodeBase64UrlCanonical(value.wrapped.ciphertext, {
            minBytes: 16,
            maxBytes: MAX_VAULT_PLAINTEXT_BYTES,
        });
    }
    if (value.wrappedDeviceKeys !== null) {
        if (!isPlainRecord(value.wrappedDeviceKeys)
            || !exactKeys(value.wrappedDeviceKeys, ['nonce', 'ciphertext'])
            || typeof value.wrappedDeviceKeys.nonce !== 'string'
            || typeof value.wrappedDeviceKeys.ciphertext !== 'string') {
            throw new Error('Invalid wrapped E2EE control device keys');
        }
        decodeBase64UrlCanonical(value.wrappedDeviceKeys.nonce, { exactBytes: 12 });
        decodeBase64UrlCanonical(value.wrappedDeviceKeys.ciphertext, {
            minBytes: 16,
            maxBytes: MAX_VAULT_PLAINTEXT_BYTES,
        });
    }
    return value as unknown as VaultRecordV1;
}

async function generateWrappingKey(): Promise<CryptoKey> {
    return crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
}

class VaultGenerationConflict extends Error {
    constructor() {
        super('Local E2EE vault generation changed during write');
    }
}

export class E2eeIndexedDbKeyVault {
    constructor(private readonly storage: E2eeVaultStorage = e2eeIndexedDbStorage) {}

    private async getOrCreateRecord(context: E2eeVaultContext): Promise<VaultRecordV1> {
        const storageKey = vaultStorageKey(context);
        const existing = await this.storage.get<unknown>(storageKey);
        if (existing !== undefined) return validateVaultRecord(existing, context);
        const candidateKey = await generateWrappingKey();
        const candidate: VaultRecordV1 = {
            v: 1,
            domain: VAULT_KEY_DOMAIN,
            suite: E2EE_SUITE,
            ...context,
            generation: encodeBase64UrlCanonical(secureRandomBytes(VAULT_GENERATION_BYTES)),
            key: candidateKey,
            wrapped: null,
            wrappedDeviceKeys: null,
        };
        // IDB update is a single readwrite transaction.  Concurrent tabs all
        // converge on the first stored non-extractable key instead of creating
        // a key/ciphertext split-brain.
        await this.storage.update<unknown>(storageKey, (existing) => existing ?? candidate);
        const stored = await this.storage.get<unknown>(storageKey);
        return validateVaultRecord(stored, context);
    }

    async storeKeyring(context: E2eeVaultContext, keyringInput: E2eeEpochKeyring): Promise<void> {
        validateContext(context);
        const keyring = validateKeyring(keyringInput);
        const recordKey = vaultStorageKey(context);
        const plaintext = utf8(jcsCanonicalize({
            accountId: context.accountId,
            currentEpoch: keyring.currentEpoch,
            deviceId: context.deviceId,
            domain: VAULT_PAYLOAD_DOMAIN,
            epochs: keyring.epochs.map((item) => ({
                epoch: item.epoch,
                secret: encodeBase64UrlCanonical(item.secret),
            })),
            origin: context.origin,
            suite: E2EE_SUITE,
            v: 1,
        }));
        try {
            for (let attempt = 0; attempt < MAX_VAULT_WRITE_RETRIES; attempt += 1) {
                const currentRecord = await this.getOrCreateRecord(context);
                if (currentRecord.wrapped && keyring.currentEpoch < currentRecord.wrapped.currentEpoch) {
                    throw new Error('Refusing to roll back local E2EE keyring');
                }
                const nonce = secureRandomBytes(12);
                const ciphertext = await crypto.subtle.encrypt({
                    name: 'AES-GCM',
                    iv: nonce as BufferSource,
                    additionalData: vaultAad(context, keyring.currentEpoch) as BufferSource,
                    tagLength: 128,
                }, currentRecord.key, plaintext as BufferSource);
                const wrapped = {
                    currentEpoch: keyring.currentEpoch,
                    nonce: encodeBase64UrlCanonical(nonce),
                    ciphertext: encodeBase64UrlCanonical(new Uint8Array(ciphertext)),
                };
                try {
                    await this.storage.update<unknown>(recordKey, (value) => {
                        const latest = validateVaultRecord(value, context);
                        if (latest.generation !== currentRecord.generation) {
                            throw new VaultGenerationConflict();
                        }
                        if (latest.wrapped && keyring.currentEpoch < latest.wrapped.currentEpoch) {
                            throw new Error('Refusing to roll back local E2EE keyring');
                        }
                        return { ...latest, wrapped } satisfies VaultRecordV1;
                    });
                    return;
                } catch (error) {
                    if (!(error instanceof VaultGenerationConflict)) throw error;
                }
            }
            throw new Error('Local E2EE vault changed too frequently');
        } finally {
            plaintext.fill(0);
            keyring.epochs.forEach((item) => item.secret.fill(0));
        }
    }

    async loadKeyring(
        context: E2eeVaultContext,
        options: { highestKnownEpoch?: number } = {},
    ): Promise<E2eeEpochKeyring | null> {
        validateContext(context);
        const storedValue = await this.storage.get<unknown>(vaultStorageKey(context));
        if (storedValue === undefined) return null;
        const record = validateVaultRecord(storedValue, context);
        const wrapped = record.wrapped;
        if (!wrapped) return null;
        if (options.highestKnownEpoch !== undefined) {
            assertE2eeEpoch(options.highestKnownEpoch);
            if (wrapped.currentEpoch < options.highestKnownEpoch) {
                throw new Error('Local E2EE keyring rollback detected');
            }
        }
        let plaintext: Uint8Array;
        try {
            const result = await crypto.subtle.decrypt({
                name: 'AES-GCM',
                iv: decodeBase64UrlCanonical(wrapped.nonce, { exactBytes: 12 }) as BufferSource,
                additionalData: vaultAad(context, wrapped.currentEpoch) as BufferSource,
                tagLength: 128,
            }, record.key, decodeBase64UrlCanonical(wrapped.ciphertext, {
                minBytes: 16,
                maxBytes: MAX_VAULT_PLAINTEXT_BYTES,
            }) as BufferSource);
            plaintext = new Uint8Array(result);
        } catch {
            throw new Error('Local E2EE keyring authentication failed');
        }
        let parsed: unknown;
        try {
            parsed = parseCanonicalJcs(utf8String(plaintext), MAX_VAULT_PLAINTEXT_BYTES);
        } finally {
            plaintext.fill(0);
        }
        if (!isPlainRecord(parsed)
            || !exactKeys(parsed, [
                'v', 'domain', 'suite', 'origin', 'accountId', 'deviceId',
                'currentEpoch', 'epochs',
            ])
            || parsed.v !== 1 || parsed.domain !== VAULT_PAYLOAD_DOMAIN || parsed.suite !== E2EE_SUITE
            || parsed.origin !== context.origin || parsed.accountId !== context.accountId
            || parsed.deviceId !== context.deviceId || parsed.currentEpoch !== wrapped.currentEpoch
            || !Array.isArray(parsed.epochs)) {
            throw new Error('Local E2EE keyring context does not match');
        }
        const decodedEpochs: Array<{ epoch: number; secret: Uint8Array }> = [];
        try {
            for (const item of parsed.epochs) {
                if (!isPlainRecord(item) || !exactKeys(item, ['epoch', 'secret'])
                    || typeof item.epoch !== 'number' || typeof item.secret !== 'string') {
                    throw new Error('Invalid local E2EE keyring epoch');
                }
                decodedEpochs.push({
                    epoch: item.epoch,
                    secret: decodeBase64UrlCanonical(item.secret, { exactBytes: 32 }),
                });
            }
            return validateKeyring({ currentEpoch: wrapped.currentEpoch, epochs: decodedEpochs });
        } finally {
            decodedEpochs.forEach((item) => item.secret.fill(0));
        }
    }

    async storeControlDevicePrivateKeys(
        context: E2eeVaultContext,
        keys: E2eeControlDevicePrivateKeys,
    ): Promise<void> {
        validateContext(context);
        if (!(keys.encryptionPrivateKey instanceof Uint8Array)
            || keys.encryptionPrivateKey.length !== 32
            || !(keys.signingPrivateKey instanceof Uint8Array)
            || keys.signingPrivateKey.length !== 64) {
            throw new Error('Invalid E2EE control device private keys');
        }
        const recordKey = vaultStorageKey(context);
        const plaintext = utf8(jcsCanonicalize({
            accountId: context.accountId,
            deviceId: context.deviceId,
            domain: VAULT_DEVICE_KEYS_DOMAIN,
            encryptionPrivateKey: encodeBase64UrlCanonical(keys.encryptionPrivateKey),
            origin: context.origin,
            signingPrivateKey: encodeBase64UrlCanonical(keys.signingPrivateKey),
            suite: E2EE_SUITE,
            v: 1,
        }));
        try {
            for (let attempt = 0; attempt < MAX_VAULT_WRITE_RETRIES; attempt += 1) {
                const record = await this.getOrCreateRecord(context);
                const nonce = secureRandomBytes(12);
                const ciphertext = await crypto.subtle.encrypt({
                    name: 'AES-GCM',
                    iv: nonce as BufferSource,
                    additionalData: deviceKeysAad(context) as BufferSource,
                    tagLength: 128,
                }, record.key, plaintext as BufferSource);
                const wrappedDeviceKeys = {
                    nonce: encodeBase64UrlCanonical(nonce),
                    ciphertext: encodeBase64UrlCanonical(new Uint8Array(ciphertext)),
                };
                try {
                    await this.storage.update<unknown>(recordKey, (value) => {
                        const latest = validateVaultRecord(value, context);
                        if (latest.generation !== record.generation) {
                            throw new VaultGenerationConflict();
                        }
                        return { ...latest, wrappedDeviceKeys } satisfies VaultRecordV1;
                    });
                    return;
                } catch (error) {
                    if (!(error instanceof VaultGenerationConflict)) throw error;
                }
            }
            throw new Error('Local E2EE vault changed too frequently');
        } finally {
            plaintext.fill(0);
        }
    }

    async loadControlDevicePrivateKeys(
        context: E2eeVaultContext,
    ): Promise<E2eeControlDevicePrivateKeys | null> {
        validateContext(context);
        const storedValue = await this.storage.get<unknown>(vaultStorageKey(context));
        if (storedValue === undefined) return null;
        const record = validateVaultRecord(storedValue, context);
        if (!record.wrappedDeviceKeys) return null;
        let plaintext: Uint8Array;
        try {
            const result = await crypto.subtle.decrypt({
                name: 'AES-GCM',
                iv: decodeBase64UrlCanonical(record.wrappedDeviceKeys.nonce, {
                    exactBytes: 12,
                }) as BufferSource,
                additionalData: deviceKeysAad(context) as BufferSource,
                tagLength: 128,
            }, record.key, decodeBase64UrlCanonical(record.wrappedDeviceKeys.ciphertext, {
                minBytes: 16,
                maxBytes: MAX_VAULT_PLAINTEXT_BYTES,
            }) as BufferSource);
            plaintext = new Uint8Array(result);
        } catch {
            throw new Error('Local E2EE control device keys authentication failed');
        }
        let parsed: unknown;
        try {
            parsed = parseCanonicalJcs(utf8String(plaintext), MAX_VAULT_PLAINTEXT_BYTES);
        } finally {
            plaintext.fill(0);
        }
        if (!isPlainRecord(parsed)
            || !exactKeys(parsed, [
                'v', 'domain', 'suite', 'origin', 'accountId', 'deviceId',
                'encryptionPrivateKey', 'signingPrivateKey',
            ])
            || parsed.v !== 1 || parsed.domain !== VAULT_DEVICE_KEYS_DOMAIN
            || parsed.suite !== E2EE_SUITE || parsed.origin !== context.origin
            || parsed.accountId !== context.accountId || parsed.deviceId !== context.deviceId
            || typeof parsed.encryptionPrivateKey !== 'string'
            || typeof parsed.signingPrivateKey !== 'string') {
            throw new Error('Local E2EE control device keys context does not match');
        }
        return {
            encryptionPrivateKey: decodeBase64UrlCanonical(parsed.encryptionPrivateKey, {
                exactBytes: 32,
            }),
            signingPrivateKey: decodeBase64UrlCanonical(parsed.signingPrivateKey, {
                exactBytes: 64,
            }),
        };
    }

    async remove(context: E2eeVaultContext): Promise<void> {
        validateContext(context);
        await this.storage.del(vaultStorageKey(context));
    }
}
