import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import {
    contentKeyPairFromSecret,
    decodeAccountSecret,
    decryptWithDataKey,
    deriveKey,
    encryptWithDataKey,
    unwrapDataEncryptionKey,
    wrapDataEncryptionKey,
} from './sessionCrypto';

/**
 * Independent re-implementation of the CLI's `libsodiumEncryptForPublicKey`
 * (packages/happy-cli/src/api/encryption.ts) so the server's unwrap is tested
 * against the format the CLI actually writes into Session.dataEncryptionKey.
 */
function cliWrap(dek: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
    const ephemeral = tweetnacl.box.keyPair();
    const nonce = tweetnacl.randomBytes(tweetnacl.box.nonceLength);
    const encrypted = tweetnacl.box(dek, nonce, recipientPublicKey, ephemeral.secretKey);
    const bundle = new Uint8Array(ephemeral.publicKey.length + nonce.length + encrypted.length);
    bundle.set(ephemeral.publicKey, 0);
    bundle.set(nonce, ephemeral.publicKey.length);
    bundle.set(encrypted, ephemeral.publicKey.length + nonce.length);
    const versioned = new Uint8Array(bundle.length + 1);
    versioned.set([0], 0);
    versioned.set(bundle, 1);
    return versioned;
}

/** CLI `libsodiumPublicKeyFromSecretKey(deriveKey(secret, 'Happy EnCoder', ['content']))`. */
function cliContentPublicKey(seed: Uint8Array): Uint8Array {
    const hashed = new Uint8Array(createHash('sha512').update(seed).digest());
    return new Uint8Array(tweetnacl.box.keyPair.fromSecretKey(hashed.slice(0, 32)).publicKey);
}

describe('B-619 sessionCrypto', () => {
    const master = decodeAccountSecret(Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64url'));

    it('derives the key tree exactly like the CLI / web (known vector)', () => {
        // Vector computed with packages/happy-cli/src/utils/deriveKey.ts (HMAC-SHA512 tree).
        const key = deriveKey(master, 'Happy EnCoder', ['content']);
        expect(Buffer.from(key).toString('hex')).toBe(
            Buffer.from(deriveKeyReference(master, 'Happy EnCoder', ['content'])).toString('hex'),
        );
        expect(key).toHaveLength(32);
    });

    it('content public key matches the CLI derivation', () => {
        const pair = contentKeyPairFromSecret(master);
        expect(Buffer.from(pair.publicKey)).toEqual(Buffer.from(cliContentPublicKey(deriveKey(master, 'Happy EnCoder', ['content']))));
    });

    it('unwraps a DEK the CLI wrapped and re-wraps it for another account', () => {
        const owner = contentKeyPairFromSecret(master);
        const grantee = contentKeyPairFromSecret(decodeAccountSecret(Buffer.alloc(32, 7).toString('base64url')));
        const dek = tweetnacl.randomBytes(32);
        const fromCli = cliWrap(dek, owner.publicKey);
        expect(Buffer.from(unwrapDataEncryptionKey(fromCli, owner)!)).toEqual(Buffer.from(dek));
        expect(unwrapDataEncryptionKey(fromCli, grantee)).toBeNull();
        const rewrapped = wrapDataEncryptionKey(dek, grantee.publicKey);
        expect(rewrapped[0]).toBe(0);
        expect(Buffer.from(unwrapDataEncryptionKey(rewrapped, grantee)!)).toEqual(Buffer.from(dek));
        expect(unwrapDataEncryptionKey(rewrapped, owner)).toBeNull();
    });

    it('rejects malformed wrapped keys instead of throwing', () => {
        const owner = contentKeyPairFromSecret(master);
        expect(unwrapDataEncryptionKey(new Uint8Array([1, 2, 3]), owner)).toBeNull();
        expect(unwrapDataEncryptionKey(new Uint8Array(80).fill(0), owner)).toBeNull();
    });

    it('AES-GCM bundle round-trips and is version 0 like the CLI', () => {
        const dek = tweetnacl.randomBytes(32);
        const record = { role: 'user', content: { type: 'text', text: 'hi' }, meta: { sentFrom: 'shared' } };
        const bundle = encryptWithDataKey(record, dek);
        expect(bundle[0]).toBe(0);
        expect(decryptWithDataKey(bundle, dek)).toEqual(record);
        expect(decryptWithDataKey(bundle, tweetnacl.randomBytes(32))).toBeNull();
        const tampered = new Uint8Array(bundle); tampered[20] ^= 1;
        expect(decryptWithDataKey(tampered, dek)).toBeNull();
    });

    it('decodeAccountSecret insists on 32 bytes', () => {
        expect(() => decodeAccountSecret(Buffer.alloc(16).toString('base64url'))).toThrow();
    });
});

// Reference implementation copied from packages/happy-cli/src/utils/deriveKey.ts (async form made sync).
function deriveKeyReference(master: Uint8Array, usage: string, path: string[]): Uint8Array {
    const { createHmac } = require('node:crypto') as typeof import('node:crypto');
    const hmac = (k: Uint8Array, d: Uint8Array) => new Uint8Array(createHmac('sha512', k).update(d).digest());
    let I = hmac(new TextEncoder().encode(usage + ' Master Seed'), master);
    let state = { key: I.slice(0, 32), chainCode: I.slice(32) };
    for (const index of path) {
        I = hmac(state.chainCode, new Uint8Array([0x0, ...new TextEncoder().encode(index)]));
        state = { key: I.subarray(0, 32), chainCode: I.subarray(32) };
    }
    return state.key;
}
