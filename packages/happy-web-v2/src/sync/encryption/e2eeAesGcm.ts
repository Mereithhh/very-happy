import {
    decodeBase64UrlCanonical,
    encodeBase64UrlCanonical,
    secureRandomBytes,
} from './e2eeEncoding';

const AES_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const MAX_CIPHERTEXT_BYTES = 16 * 1024 * 1024;

async function importAesKey(key: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
    if (key.length !== AES_KEY_BYTES) throw new Error('AES-256-GCM key must be 32 bytes');
    return crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, [usage]);
}

export async function encryptE2eeAesGcm(
    key: Uint8Array,
    plaintext: Uint8Array,
    aad: Uint8Array,
    nonce = secureRandomBytes(GCM_NONCE_BYTES),
): Promise<{ nonce: string; ciphertext: string }> {
    if (nonce.length !== GCM_NONCE_BYTES) throw new Error('AES-GCM nonce must be 12 bytes');
    if (plaintext.length + GCM_TAG_BYTES > MAX_CIPHERTEXT_BYTES) {
        throw new Error('AES-GCM plaintext is too large');
    }
    const cryptoKey = await importAesKey(key, 'encrypt');
    const ciphertext = await crypto.subtle.encrypt({
        name: 'AES-GCM',
        iv: nonce as BufferSource,
        additionalData: aad as BufferSource,
        tagLength: 128,
    }, cryptoKey, plaintext as BufferSource);
    return {
        nonce: encodeBase64UrlCanonical(nonce),
        ciphertext: encodeBase64UrlCanonical(new Uint8Array(ciphertext)),
    };
}

export async function decryptE2eeAesGcm(
    key: Uint8Array,
    encrypted: { nonce: string; ciphertext: string },
    aad: Uint8Array,
): Promise<Uint8Array> {
    const nonce = decodeBase64UrlCanonical(encrypted.nonce, { exactBytes: GCM_NONCE_BYTES });
    const ciphertext = decodeBase64UrlCanonical(encrypted.ciphertext, {
        minBytes: GCM_TAG_BYTES,
        maxBytes: MAX_CIPHERTEXT_BYTES,
    });
    const cryptoKey = await importAesKey(key, 'decrypt');
    try {
        const plaintext = await crypto.subtle.decrypt({
            name: 'AES-GCM',
            iv: nonce as BufferSource,
            additionalData: aad as BufferSource,
            tagLength: 128,
        }, cryptoKey, ciphertext as BufferSource);
        return new Uint8Array(plaintext);
    } catch {
        throw new Error('E2EE AES-GCM authentication failed');
    }
}

