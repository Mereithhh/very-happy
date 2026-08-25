import { deriveKey } from "@/encryption/deriveKey";
import { AES256Encryption, SecretBoxEncryption, Encryptor, Decryptor } from "./encryptor";
import { encodeHex } from "@/encryption/hex";
import { EncryptionCache } from "./encryptionCache";
import { SessionEncryption } from "./sessionEncryption";
import { MachineEncryption } from "./machineEncryption";
import { encodeBase64, decodeBase64 } from "@/encryption/base64";
import sodium from '@/encryption/libsodium.lib';
import { decryptBox, encryptBox } from "@/encryption/libsodium";
import { randomUUID } from 'expo-crypto';
import type { E2eeRuntimeKeys } from '@/auth/e2eeRuntime';
import type { E2eeAuthCredentials } from '@/auth/tokenStorage';
import { deriveEpochContentKeyPair } from '@/auth/e2eeKeyHierarchy';
import {
    decryptAccountEnvelopeBytes,
    decryptAccountEnvelopeJson,
    encryptAccountEnvelopeBytes,
    encryptAccountEnvelopeJson,
    parseAccountEnvelope,
    serializeAccountEnvelope,
} from './e2eeAccountEnvelope';
import { deriveE2eeKey } from './e2eeKdf';
import { E2EE_DOMAIN_PREFIX } from './e2eeEncoding';
import { utf8, utf8String } from './e2eeEncoding';
import {
    unwrapE2eeDataKey,
    type ExpectedWrappedDataKeyContext,
} from './e2eeWrappedDataKey';

type SodiumKeyPair = { publicKey: Uint8Array; privateKey: Uint8Array; keyType?: string };

export class Encryption {

    static async create(masterSecret: Uint8Array) {

        // Derive content data key to open session and machine records
        const contentDataKey = await deriveKey(masterSecret, 'Happy EnCoder', ['content']);

        // Derive content data key keypair
        const contentKeyPair = sodium.crypto_box_seed_keypair(contentDataKey);

        // Derive anonymous ID
        const anonID = encodeHex((await deriveKey(masterSecret, 'Happy Coder', ['analytics', 'id']))).slice(0, 16).toLowerCase();

        // Derive master blob key for legacy sessions (those with no per-session dataKey)
        const masterBlobKey = await deriveKey(masterSecret, 'Happy Blobs', ['master']);

        // Create encryption
        return new Encryption({
            anonID,
            legacySecret: masterSecret,
            contentKeyPair,
            masterBlobKey,
        });
    }

    static async createE2ee(runtime: E2eeRuntimeKeys): Promise<Encryption> {
        const epochSecrets = new Map<number, Uint8Array>();
        const contentKeyPairs = new Map<number, SodiumKeyPair>();
        try {
            for (const item of runtime.keyring.epochs) {
                epochSecrets.set(item.epoch, item.secret.slice());
                contentKeyPairs.set(item.epoch, await deriveEpochContentKeyPair(item.secret, item.epoch));
            }
            const currentSecret = epochSecrets.get(runtime.credentials.cryptoEpoch);
            const currentPair = contentKeyPairs.get(runtime.credentials.cryptoEpoch);
            if (!currentSecret || !currentPair) throw new Error('Current E2EE epoch is absent');
            const anonKey = await deriveE2eeKey(currentSecret, `${E2EE_DOMAIN_PREFIX}/analytics/id`);
            const anonID = encodeHex(anonKey).slice(0, 16).toLowerCase();
            anonKey.fill(0);
            return new Encryption({
                anonID,
                contentKeyPair: currentPair,
                e2ee: {
                    origin: runtime.credentials.origin,
                    accountId: runtime.credentials.accountId,
                    currentEpoch: runtime.credentials.cryptoEpoch,
                    epochSecrets,
                    contentKeyPairs,
                },
            });
        } catch (error) {
            epochSecrets.forEach((secret) => secret.fill(0));
            contentKeyPairs.forEach((pair) => {
                pair.privateKey.fill(0);
                pair.publicKey.fill(0);
            });
            throw error;
        }
    }

    private readonly legacyEncryption: SecretBoxEncryption | null;
    private readonly contentKeyPair: SodiumKeyPair;
    private readonly masterBlobKey: Uint8Array | null;
    private readonly e2ee: {
        origin: string;
        accountId: string;
        currentEpoch: number;
        epochSecrets: Map<number, Uint8Array>;
        contentKeyPairs: Map<number, SodiumKeyPair>;
    } | null;
    readonly anonID: string;
    readonly contentDataKey: Uint8Array;

    // Session and machine encryption management
    private sessionEncryptions = new Map<string, SessionEncryption>();
    private machineEncryptions = new Map<string, MachineEncryption>();
    private sessionBlobKeys = new Map<string, Uint8Array>();
    private cache: EncryptionCache;

    private constructor(input: {
        anonID: string;
        contentKeyPair: SodiumKeyPair;
        legacySecret?: Uint8Array;
        masterBlobKey?: Uint8Array;
        e2ee?: NonNullable<Encryption['e2ee']>;
    }) {
        this.anonID = input.anonID;
        this.contentKeyPair = input.contentKeyPair;
        this.legacyEncryption = input.legacySecret ? new SecretBoxEncryption(input.legacySecret) : null;
        this.masterBlobKey = input.masterBlobKey ?? null;
        this.e2ee = input.e2ee ?? null;
        this.cache = new EncryptionCache();
        this.contentDataKey = input.contentKeyPair.publicKey;
    }

    get isE2ee(): boolean { return this.e2ee !== null; }

    matchesE2eeAccount(credentials: E2eeAuthCredentials): boolean {
        return this.e2ee !== null
            && this.e2ee.origin === credentials.origin
            && this.e2ee.accountId === credentials.accountId
            && this.e2ee.currentEpoch === credentials.cryptoEpoch;
    }

    private e2eeKvDomain(key: string): 'tasks' | 'notes' | 'kv' {
        if (key === 'vh.board-tasks.v1') return 'tasks';
        if (key.startsWith('vh.note.v1.')) return 'notes';
        return 'kv';
    }

    /** Encrypt the exact bytes carried by the legacy base64 KV API. */
    async encryptKvValue(key: string, base64Value: string): Promise<string> {
        if (!this.e2ee) throw new Error('E2EE account encryption is unavailable');
        const secret = this.e2ee.epochSecrets.get(this.e2ee.currentEpoch);
        if (!secret) throw new Error('Current E2EE KV key is unavailable');
        const plaintext = decodeBase64(base64Value, 'base64');
        if (plaintext.length > 256 * 1024) throw new Error('KV plaintext exceeds 256 KiB');
        try {
            const envelope = await encryptAccountEnvelopeBytes({
                origin: this.e2ee.origin,
                accountId: this.e2ee.accountId,
                epochSecret: secret,
                epoch: this.e2ee.currentEpoch,
                domain: this.e2eeKvDomain(key),
                objectId: key,
                field: 'value',
                plaintext,
            });
            return encodeBase64(utf8(serializeAccountEnvelope(envelope)), 'base64');
        } finally {
            plaintext.fill(0);
        }
    }

    /** Decrypt a KV carrier and restore the byte-for-byte legacy base64 value. */
    async decryptKvValue(key: string, encryptedBase64Value: string): Promise<string> {
        if (!this.e2ee) throw new Error('E2EE account encryption is unavailable');
        const serialized = utf8String(decodeBase64(encryptedBase64Value, 'base64'));
        const envelope = parseAccountEnvelope(serialized);
        const secret = this.e2ee.epochSecrets.get(envelope.epoch);
        if (!secret) throw new Error(`Unknown E2EE KV epoch ${envelope.epoch}`);
        const plaintext = await decryptAccountEnvelopeBytes({
            origin: this.e2ee.origin,
            accountId: this.e2ee.accountId,
            epochSecret: secret,
            envelope,
            expectedDomain: this.e2eeKvDomain(key),
            expectedObjectId: key,
            expectedField: 'value',
        });
        try {
            if (plaintext.length > 256 * 1024) throw new Error('KV plaintext exceeds 256 KiB');
            return encodeBase64(plaintext, 'base64');
        } finally {
            plaintext.fill(0);
        }
    }

    //
    // Core encryption opening
    //

    async openEncryption(dataEncryptionKey: Uint8Array | null): Promise<Encryptor & Decryptor> {
        if (!dataEncryptionKey) {
            if (!this.legacyEncryption) {
                throw new Error('E2EE records require a per-object data key');
            }
            return this.legacyEncryption;
        }
        return new AES256Encryption(dataEncryptionKey);
    }

    //
    // Session operations
    //

    /**
     * Initialize sessions with their encryption keys
     * This should be called once when sessions are loaded
     */
    async initializeSessions(sessions: Map<string, Uint8Array | null>): Promise<void> {
        for (const [sessionId, dataKey] of sessions) {
            // Skip if already initialized
            if (this.sessionEncryptions.has(sessionId)) {
                continue;
            }

            // Create appropriate encryptor based on data key
            const encryptor = await this.openEncryption(dataKey);

            // Create and cache session encryption
            const sessionEnc = new SessionEncryption(
                sessionId,
                encryptor,
                this.cache
            );
            this.sessionEncryptions.set(sessionId, sessionEnc);

            // Derive blob key for this session.
            // Legacy sessions (null dataKey) use the master blob key.
            // Newer sessions derive a subkey from their own dataKey so blobs
            // are cryptographically isolated from message encryption.
            const blobKey = dataKey
                ? await deriveKey(dataKey, 'Happy Blobs', ['session'])
                : this.masterBlobKey!;
            this.sessionBlobKeys.set(sessionId, blobKey);
        }
    }

    /**
     * Get session encryption if it has been initialized
     * Returns null if not initialized (should never happen in normal flow)
     */
    getSessionEncryption(sessionId: string): SessionEncryption | null {
        return this.sessionEncryptions.get(sessionId) || null;
    }

    /**
     * Remove session encryption from memory when session is deleted
     */
    removeSessionEncryption(sessionId: string): void {
        this.sessionEncryptions.delete(sessionId);
        this.sessionBlobKeys.delete(sessionId);
        // Also clear any cached data for this session
        this.cache.clearSessionCache(sessionId);
    }

    /**
     * Get the 32-byte NaCl secretbox key for encrypting binary blobs
     * (image attachments) in a session. Distinct from the message encryption
     * key to maintain cryptographic separation.
     * Returns null if the session has not been initialized.
     */
    getSessionBlobKey(sessionId: string): Uint8Array | null {
        return this.sessionBlobKeys.get(sessionId) ?? null;
    }

    //
    // Machine operations
    //

    /**
     * Initialize machines with their encryption keys
     * This should be called once when machines are loaded
     */
    async initializeMachines(machines: Map<string, Uint8Array | null>): Promise<void> {
        for (const [machineId, dataKey] of machines) {
            // Skip if already initialized
            if (this.machineEncryptions.has(machineId)) {
                continue;
            }

            // Create appropriate encryptor based on data key
            const encryptor = await this.openEncryption(dataKey);

            // Create and cache machine encryption
            const machineEnc = new MachineEncryption(
                machineId,
                encryptor,
                this.cache
            );
            this.machineEncryptions.set(machineId, machineEnc);
        }
    }

    /**
     * Get machine encryption if it has been initialized
     * Returns null if not initialized (should never happen in normal flow)
     */
    getMachineEncryption(machineId: string): MachineEncryption | null {
        return this.machineEncryptions.get(machineId) || null;
    }

    /**
     * Remove machine encryption from memory when the machine is deleted
     */
    removeMachineEncryption(machineId: string): void {
        this.machineEncryptions.delete(machineId);
    }

    //
    // Legacy methods for machine metadata (temporary until machines are migrated)
    //

    async encryptRaw(data: any): Promise<string> {
        if (this.e2ee) {
            const secret = this.e2ee.epochSecrets.get(this.e2ee.currentEpoch);
            if (!secret) throw new Error('Current E2EE settings key is unavailable');
            const envelope = await encryptAccountEnvelopeJson({
                origin: this.e2ee.origin,
                accountId: this.e2ee.accountId,
                epochSecret: secret,
                epoch: this.e2ee.currentEpoch,
                domain: 'settings',
                objectId: this.e2ee.accountId,
                field: 'settings',
                value: data,
            });
            return serializeAccountEnvelope(envelope);
        }
        if (!this.legacyEncryption) throw new Error('Legacy encryption is unavailable');
        const encrypted = await this.legacyEncryption.encrypt([data]);
        return encodeBase64(encrypted[0], 'base64');
    }

    async decryptRaw(encrypted: string): Promise<any | null> {
        if (this.e2ee) {
            const envelope = parseAccountEnvelope(encrypted);
            const secret = this.e2ee.epochSecrets.get(envelope.epoch);
            if (!secret) throw new Error(`Unknown E2EE settings epoch ${envelope.epoch}`);
            return decryptAccountEnvelopeJson({
                origin: this.e2ee.origin,
                accountId: this.e2ee.accountId,
                epochSecret: secret,
                envelope,
                expectedDomain: 'settings',
                expectedObjectId: this.e2ee.accountId,
                expectedField: 'settings',
            });
        }
        if (!this.legacyEncryption) throw new Error('Legacy encryption is unavailable');
        try {
            const encryptedData = decodeBase64(encrypted, 'base64');
            const decrypted = await this.legacyEncryption.decrypt([encryptedData]);
            return decrypted[0] || null;
        } catch (error) {
            return null;
        }
    }

    //
    // Data Encryption Key decryption
    //

    async decryptEncryptionKey(
        encrypted: string,
        expected?: Omit<ExpectedWrappedDataKeyContext, 'origin' | 'accountId'>,
    ) {
        // Never throw: callers (fetchMachines/fetchSessions/artifacts) iterate
        // many keys, and an exception on one malformed/foreign key would
        // reject the whole sync and silently drop every item. Always degrade
        // to null so the caller can decide per-item.
        try {
            if (this.e2ee) {
                if (!expected) return null;
                return unwrapE2eeDataKey(
                    encrypted,
                    (epoch) => this.e2ee?.contentKeyPairs.get(epoch)?.privateKey ?? null,
                    { ...expected, origin: this.e2ee.origin, accountId: this.e2ee.accountId },
                );
            }
            const encryptedKey = decodeBase64(encrypted, 'base64');
            if (encryptedKey[0] !== 0) {
                return null;
            }

            const decrypted = decryptBox(encryptedKey.slice(1), this.contentKeyPair.privateKey);
            if (!decrypted) {
                return null;
            }
            return decrypted;
        } catch (error) {
            console.error('decryptEncryptionKey failed:', error);
            return null;
        }
    }

    async encryptEncryptionKey(key: Uint8Array): Promise<Uint8Array> {
        if (this.e2ee) {
            throw new Error('E2EE data keys require a context-bound WrappedDataKeyV1 envelope');
        }
        // Use public key for encryption (encrypt TO ourselves)
        const encrypted = encryptBox(key, this.contentKeyPair.publicKey);
        const result = new Uint8Array(encrypted.length + 1);
        result[0] = 0; // Version byte
        result.set(encrypted, 1);
        return result;
    }

    generateId(): string {
        return randomUUID();
    }

    destroy(): void {
        this.cache.clearAll();
        this.sessionEncryptions.clear();
        this.machineEncryptions.clear();
        this.sessionBlobKeys.forEach((key) => key.fill(0));
        this.sessionBlobKeys.clear();
        if (this.e2ee) {
            this.e2ee.epochSecrets.forEach((secret) => secret.fill(0));
            this.e2ee.epochSecrets.clear();
            this.e2ee.contentKeyPairs.forEach((pair) => {
                pair.privateKey.fill(0);
                pair.publicKey.fill(0);
            });
            this.e2ee.contentKeyPairs.clear();
        }
    }
}
