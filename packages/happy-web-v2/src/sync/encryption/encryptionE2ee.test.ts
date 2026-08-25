import { describe, expect, it } from 'vitest';
import sodium from '@/encryption/libsodium.lib';
import {
    E2EE_PROTOCOL_VERSION,
    E2EE_SUITE_V1,
    WrappedDataKeyPlaintextV1Schema,
    WrappedDataKeyV1Schema,
    canonicalizeE2eeJson,
} from '@slopus/happy-wire';
import { Encryption } from './encryption';
import { deriveEpochContentKeyPair } from '@/auth/e2eeKeyHierarchy';
import type { E2eeRuntimeKeys } from '@/auth/e2eeRuntime';
import {
    encryptAccountEnvelopeJson,
    parseAccountEnvelope,
    serializeAccountEnvelope,
} from './e2eeAccountEnvelope';
import { encodeBase64UrlCanonical } from './e2eeEncoding';

const epochOne = new Uint8Array(32).fill(11);
const epochTwo = new Uint8Array(32).fill(22);
const publicKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const signature = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function runtime(): E2eeRuntimeKeys {
    return {
        credentials: {
            version: 2,
            token: 'token',
            origin: 'https://happy.example',
            accountId: 'account_1',
            deviceId: 'device_1',
            cryptoMode: 'e2ee-v1',
            e2eeProtocol: 'vh-e2ee-1',
            cryptoEpoch: 2,
            recoveryAuthorityPublicKey: publicKey,
            contentPublicKey: publicKey,
            contentKeySignature: signature,
        },
        keyring: {
            currentEpoch: 2,
            epochs: [
                { epoch: 1, secret: epochOne.slice() },
                { epoch: 2, secret: epochTwo.slice() },
            ],
        },
        deviceKeys: {
            encryptionPrivateKey: new Uint8Array(32).fill(3),
            signingPrivateKey: new Uint8Array(64).fill(4),
        },
    };
}

describe('Encryption E2EE mode', () => {
    it('writes settings at current epoch and reads authenticated historical epochs', async () => {
        const encryption = await Encryption.createE2ee(runtime());
        const current = await encryption.encryptRaw({ theme: 'dark', count: 2 });
        expect(parseAccountEnvelope(current)).toMatchObject({
            epoch: 2,
            domain: 'settings',
            objectId: 'account_1',
            field: 'settings',
        });
        await expect(encryption.decryptRaw(current)).resolves.toEqual({ count: 2, theme: 'dark' });

        const historical = await encryptAccountEnvelopeJson({
            origin: 'https://happy.example',
            accountId: 'account_1',
            epochSecret: epochOne,
            epoch: 1,
            domain: 'settings',
            objectId: 'account_1',
            field: 'settings',
            value: { theme: 'light' },
        });
        await expect(encryption.decryptRaw(serializeAccountEnvelope(historical))).resolves.toEqual({ theme: 'light' });
        await expect(encryption.openEncryption(null)).rejects.toThrow(/per-object data key/);
    });

    it('unwraps a historical DEK only for its exact account/object/field context', async () => {
        await sodium.ready;
        const contentPair = await deriveEpochContentKeyPair(epochOne, 1);
        const ephemeral = sodium.crypto_box_keypair();
        const nonce = new Uint8Array(24).fill(9);
        const dataKey = new Uint8Array(32).fill(77);
        const plaintext = WrappedDataKeyPlaintextV1Schema.parse({
            v: E2EE_PROTOCOL_VERSION,
            suite: E2EE_SUITE_V1,
            origin: 'https://happy.example',
            accountId: 'account_1',
            epoch: 1,
            domain: 'session',
            objectId: 'session_1',
            field: 'dataEncryptionKey',
            key: encodeBase64UrlCanonical(dataKey),
        });
        const plaintextBytes = new TextEncoder().encode(canonicalizeE2eeJson(plaintext));
        const ciphertext = sodium.crypto_box_easy(
            plaintextBytes,
            nonce,
            contentPair.publicKey,
            ephemeral.privateKey,
        );
        const { key: _key, ...header } = plaintext;
        const envelope = WrappedDataKeyV1Schema.parse({
            ...header,
            ephemeralPublicKey: encodeBase64UrlCanonical(ephemeral.publicKey),
            nonce: encodeBase64UrlCanonical(nonce),
            ciphertext: encodeBase64UrlCanonical(ciphertext),
        });
        const encryption = await Encryption.createE2ee(runtime());
        const serialized = canonicalizeE2eeJson(envelope);
        await expect(encryption.decryptEncryptionKey(serialized, {
            domain: 'session', objectId: 'session_1', field: 'dataEncryptionKey',
        })).resolves.toEqual(dataKey);
        await expect(encryption.decryptEncryptionKey(serialized, {
            domain: 'session', objectId: 'session_other', field: 'dataEncryptionKey',
        })).resolves.toBeNull();
        await expect(encryption.decryptEncryptionKey(JSON.stringify(envelope), {
            domain: 'session', objectId: 'session_1', field: 'dataEncryptionKey',
        })).resolves.toBeNull();
        await expect(encryption.decryptEncryptionKey('legacy-base64', {
            domain: 'session', objectId: 'session_1', field: 'dataEncryptionKey',
        })).resolves.toBeNull();
    });
});
