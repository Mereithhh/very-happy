/**
 * notificationDecrypt — decrypts session-notification feed bodies that the
 * daemon encrypted *to the account* with libsodium box.
 *
 * Wire format (produced by happy-cli `libsodiumEncryptForPublicKey`):
 *   bundle = [ ephemeralPublicKey(32) | nonce(24) | ciphertext ]
 *   recipientPublicKey = libsodiumPublicKeyFromSecretKey(accountSecretSeed)
 *                      = box keypair derived from sha512(seed)[0:32]
 *
 * To open it we need the matching box *secret* key. libsodium's
 * `crypto_box_seed_keypair(seed)` performs exactly that sha512-then-slice
 * derivation, so its `privateKey` is the recipient box secret key. Any device
 * holding the account secret seed can therefore decrypt — satisfying multi-end.
 */

import sodium from '@/encryption/libsodium.lib';
import { decodeBase64 } from '@/encryption/base64';
import { z } from 'zod';

/**
 * Derive the account box secret key from the raw account secret seed and open
 * a `[ephPub32|nonce24|ct]` libsodium box bundle. Returns the plaintext bytes,
 * or `null` on any failure (wrong key, corrupt bundle, truncated input).
 *
 * This is the app-side counterpart to the daemon's
 * `libsodiumEncryptForPublicKey(bytes, libsodiumPublicKeyFromSecretKey(seed))`.
 */
export function libsodiumDecryptWithSecretKey(bundle: Uint8Array, secretSeed: Uint8Array): Uint8Array | null {
    try {
        const pubBytes = sodium.crypto_box_PUBLICKEYBYTES;
        const nonceBytes = sodium.crypto_box_NONCEBYTES;
        if (bundle.length <= pubBytes + nonceBytes) {
            return null;
        }
        // Box secret key derived from the seed (matches CLI sha512(seed)[0:32]).
        const boxSecretKey = sodium.crypto_box_seed_keypair(secretSeed).privateKey;

        const ephemeralPublicKey = bundle.slice(0, pubBytes);
        const nonce = bundle.slice(pubBytes, pubBytes + nonceBytes);
        const ciphertext = bundle.slice(pubBytes + nonceBytes);

        const decrypted = sodium.crypto_box_open_easy(ciphertext, nonce, ephemeralPublicKey, boxSecretKey);
        return decrypted ?? null;
    } catch {
        return null;
    }
}

// Plaintext body shape the daemon encrypts (see CONTRACT).
const NotificationPayloadSchema = z.object({
    title: z.string(),
    snippet: z.string().optional().default(''),
    sessionId: z.string().optional(),
    ts: z.number().optional(),
});
export type NotificationPayload = z.infer<typeof NotificationPayloadSchema>;

/**
 * Decode a base64 `enc` field → decrypt with the account seed → parse JSON
 * plaintext. Returns `null` if anything fails so the caller can degrade
 * gracefully (skip the item) instead of throwing.
 */
export function decryptNotificationEnc(enc: string, secretSeed: Uint8Array): NotificationPayload | null {
    try {
        const bundle = decodeBase64(enc, 'base64');
        const plaintext = libsodiumDecryptWithSecretKey(bundle, secretSeed);
        if (!plaintext) {
            return null;
        }
        const json = JSON.parse(new TextDecoder().decode(plaintext));
        const parsed = NotificationPayloadSchema.safeParse(json);
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}
