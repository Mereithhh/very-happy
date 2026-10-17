/**
 * B-619 session sharing — server-side session crypto.
 *
 * Very Happy is server-trusted storage, not end-to-end encrypted
 * (docs/encryption.md): the server already holds every account's master
 * secret (`AccountSecret`, sealed with HANDY_MASTER_SECRET). Until B-619 no
 * server code path actually used that secret to open session content; this
 * module is that path, and it exists for exactly two jobs:
 *
 *  1. re-wrap a session's data encryption key (DEK) for a grantee so they
 *     can decrypt the SAME ciphertext the owner does;
 *  2. write a grantee-authored user message into the session, encrypted with
 *     the DEK, with a server-asserted sender header and NO mode/model/steer
 *     meta — the daemon stays untouched and cannot tell the difference.
 *
 * Formats mirror packages/happy-cli/src/api/encryption.ts and
 * packages/happy-web-v2/src/sync/encryption/* byte for byte:
 *  - key tree: HMAC-SHA512 "<usage> Master Seed" + 0x00-prefixed child index
 *  - content key pair: libsodium crypto_box_seed_keypair(deriveKey(master,
 *    'Happy EnCoder', ['content'])) = box.keyPair.fromSecretKey(sha512(seed)[0..32])
 *  - wrapped DEK: 0x00 ‖ ephemeralPub(32) ‖ nonce(24) ‖ box(dek)
 *  - content: 0x00 ‖ nonce(12) ‖ AES-256-GCM ciphertext ‖ tag(16)
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import tweetnacl from 'tweetnacl';

export type ContentKeyPair = { publicKey: Uint8Array; secretKey: Uint8Array };

function hmacSha512(key: Uint8Array, data: Uint8Array): Uint8Array {
    return new Uint8Array(createHmac('sha512', key).update(data).digest());
}

export function deriveKey(master: Uint8Array, usage: string, path: string[]): Uint8Array {
    const root = hmacSha512(new TextEncoder().encode(`${usage} Master Seed`), master);
    let key = root.slice(0, 32);
    let chainCode = root.slice(32);
    for (const index of path) {
        const data = new Uint8Array([0x0, ...new TextEncoder().encode(index)]);
        const derived = hmacSha512(chainCode, data);
        key = derived.slice(0, 32);
        chainCode = derived.slice(32);
    }
    return key;
}

/** `AccountSecret.secret` is the base64url of the 32-byte master seed (accountAuthRoutes, web tokenStorage). */
export function decodeAccountSecret(secret: string): Uint8Array {
    const bytes = new Uint8Array(Buffer.from(secret, 'base64url'));
    if (bytes.length !== 32) throw new Error('account secret is not 32 bytes');
    return bytes;
}

export function contentKeyPairFromSecret(masterSecret: Uint8Array): ContentKeyPair {
    const seed = deriveKey(masterSecret, 'Happy EnCoder', ['content']);
    const hashedSeed = new Uint8Array(createHash('sha512').update(seed).digest());
    const pair = tweetnacl.box.keyPair.fromSecretKey(hashedSeed.slice(0, 32));
    return { publicKey: new Uint8Array(pair.publicKey), secretKey: new Uint8Array(pair.secretKey) };
}

/** Inverse of the CLI's `libsodiumEncryptForPublicKey` + version byte (api.ts createSession). */
export function unwrapDataEncryptionKey(wrapped: Uint8Array, recipient: ContentKeyPair): Uint8Array | null {
    if (wrapped.length < 1 + 32 + 24 + 16 || wrapped[0] !== 0) return null;
    const ephemeralPublicKey = wrapped.slice(1, 33);
    const nonce = wrapped.slice(33, 57);
    const box = wrapped.slice(57);
    const opened = tweetnacl.box.open(box, nonce, ephemeralPublicKey, recipient.secretKey);
    return opened ? new Uint8Array(opened) : null;
}

export function wrapDataEncryptionKey(dek: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
    const ephemeral = tweetnacl.box.keyPair();
    const nonce = new Uint8Array(randomBytes(tweetnacl.box.nonceLength));
    const box = tweetnacl.box(dek, nonce, recipientPublicKey, ephemeral.secretKey);
    const out = new Uint8Array(1 + ephemeral.publicKey.length + nonce.length + box.length);
    out.set([0], 0);
    out.set(ephemeral.publicKey, 1);
    out.set(nonce, 1 + ephemeral.publicKey.length);
    out.set(box, 1 + ephemeral.publicKey.length + nonce.length);
    return out;
}

export function encryptWithDataKey(data: unknown, dataKey: Uint8Array): Uint8Array {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dataKey, nonce);
    const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return new Uint8Array(Buffer.concat([Buffer.from([0]), nonce, encrypted, tag]));
}

export function decryptWithDataKey(bundle: Uint8Array, dataKey: Uint8Array): unknown | null {
    if (bundle.length < 1 + 12 + 16 || bundle[0] !== 0) return null;
    const nonce = bundle.slice(1, 13);
    const tag = bundle.slice(bundle.length - 16);
    const ciphertext = bundle.slice(13, bundle.length - 16);
    try {
        const decipher = createDecipheriv('aes-256-gcm', dataKey, nonce);
        decipher.setAuthTag(tag);
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return JSON.parse(decrypted.toString('utf8'));
    } catch {
        return null;
    }
}
