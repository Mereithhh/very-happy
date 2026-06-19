/**
 * Zero-dependency Web Push (RFC 8030 / 8291 / 8292), built on Node's built-in
 * `crypto`. We deliberately avoid the `web-push` npm package: happy-server is
 * deployed via bind-mounts (only `sources` + `prisma/migrations` are mounted,
 * node_modules lives in the image), so adding a runtime dependency would force
 * an image rebuild. Everything here uses primitives Node ships natively:
 * P-256 ECDH, HKDF-SHA256, AES-128-GCM, and ES256 JWT signing.
 *
 *   VAPID (RFC 8292): an ES256 JWT (aud = push origin, exp, sub) signed with
 *   the server's P-256 key, sent as `Authorization: vapid t=<jwt>, k=<pubkey>`.
 *
 *   Payload encryption (RFC 8291, aes128gcm content coding RFC 8188):
 *     ikm   = HKDF(salt=auth_secret, ikm=ecdh, info="WebPush: info\0"||ua||as, 32)
 *     CEK   = HKDF(salt=salt16, ikm, "Content-Encoding: aes128gcm\0", 16)
 *     nonce = HKDF(salt=salt16, ikm, "Content-Encoding: nonce\0", 12)
 *     body  = salt16 || recordSize(4) || idlen(1)=65 || as_public(65) || gcm(payload||0x02)
 *
 * Keys come from env (see hw-sg /opt/happy/.env):
 *   VAPID_PUBLIC_KEY  — base64url of the 65-byte uncompressed public point
 *   VAPID_PRIVATE_KEY — base64url of the 32-byte raw private scalar (d)
 *   VAPID_SUBJECT     — mailto: or https: contact (optional)
 */

import crypto from 'node:crypto';
import { log } from '@/utils/log';

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY ?? '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY ?? '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? 'mailto:admin@happy.mereith.com';

export function webPushConfigured(): boolean {
    return VAPID_PUBLIC.length > 0 && VAPID_PRIVATE.length > 0;
}

export function getVapidPublicKey(): string {
    return VAPID_PUBLIC;
}

export interface WebPushSubscription {
    endpoint: string;
    keys: { p256dh: string; auth: string };
}

/** Parse a stored `webpush:`-prefixed token into a subscription, or null. */
export function parseWebPushToken(token: string): WebPushSubscription | null {
    if (!token.startsWith('webpush:')) return null;
    try {
        const obj = JSON.parse(token.slice('webpush:'.length));
        if (obj && typeof obj.endpoint === 'string' && obj.keys?.p256dh && obj.keys?.auth) {
            return obj as WebPushSubscription;
        }
    } catch {
        /* fall through */
    }
    return null;
}

function b64url(buf: Buffer): string {
    return buf.toString('base64url');
}

/** Reconstruct the VAPID signing key as a JWK private KeyObject. */
function vapidPrivateKeyObject(): crypto.KeyObject {
    const pub = Buffer.from(VAPID_PUBLIC, 'base64url'); // 0x04 || x(32) || y(32)
    return crypto.createPrivateKey({
        format: 'jwk',
        key: {
            kty: 'EC',
            crv: 'P-256',
            d: VAPID_PRIVATE,
            x: b64url(pub.subarray(1, 33)),
            y: b64url(pub.subarray(33, 65)),
        },
    });
}

/** Build the `Authorization: vapid t=…, k=…` header for a given push endpoint. */
function vapidAuthHeader(endpoint: string): string {
    const url = new URL(endpoint);
    const aud = `${url.protocol}//${url.host}`;
    const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
    const payload = b64url(Buffer.from(JSON.stringify({ aud, exp, sub: VAPID_SUBJECT })));
    const signingInput = `${header}.${payload}`;
    // ES256 needs raw R||S (JOSE), not DER — dsaEncoding handles that.
    const sig = crypto.sign('sha256', Buffer.from(signingInput), {
        key: vapidPrivateKeyObject(),
        dsaEncoding: 'ieee-p1363',
    });
    const jwt = `${signingInput}.${b64url(sig)}`;
    return `vapid t=${jwt}, k=${VAPID_PUBLIC}`;
}

/** Encrypt the payload into an aes128gcm body for the given subscription. */
function encryptPayload(sub: WebPushSubscription, payload: Buffer): Buffer {
    const uaPublic = Buffer.from(sub.keys.p256dh, 'base64url'); // 65
    const authSecret = Buffer.from(sub.keys.auth, 'base64url');  // 16

    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    const asPublic = ecdh.getPublicKey(); // 65-byte uncompressed point
    const sharedSecret = ecdh.computeSecret(uaPublic); // 32

    const salt = crypto.randomBytes(16);

    // RFC 8291 §3.4: IKM from the combined ECDH + auth secret.
    const ikmInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
    const ikm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, authSecret, ikmInfo, 32));

    const cek = Buffer.from(
        crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
    );
    const nonce = Buffer.from(
        crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12),
    );

    const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    // Single record, last → 0x02 padding delimiter (RFC 8188 §2).
    const plaintext = Buffer.concat([payload, Buffer.from([0x02])]);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

    const recordSize = Buffer.alloc(4);
    recordSize.writeUInt32BE(4096, 0);
    const header = Buffer.concat([
        salt,                            // 16
        recordSize,                      // 4
        Buffer.from([asPublic.length]),  // 1 (= 65)
        asPublic,                        // 65
    ]);
    return Buffer.concat([header, ciphertext]);
}

export interface WebPushResult {
    ok: boolean;
    statusCode: number;
    /** 404/410 → subscription is dead and should be deleted. */
    gone: boolean;
}

/**
 * Send an encrypted Web Push message. `payload` is JSON-serialized and handed
 * to the service worker's `push` event as `event.data.json()`.
 */
export async function sendWebPush(
    sub: WebPushSubscription,
    payload: unknown,
): Promise<WebPushResult> {
    if (!webPushConfigured()) {
        return { ok: false, statusCode: 0, gone: false };
    }
    try {
        const body = encryptPayload(sub, Buffer.from(JSON.stringify(payload)));
        const res = await fetch(sub.endpoint, {
            method: 'POST',
            headers: {
                'Content-Encoding': 'aes128gcm',
                'Content-Type': 'application/octet-stream',
                TTL: '2419200', // 28 days
                Urgency: 'high',
                Authorization: vapidAuthHeader(sub.endpoint),
            },
            body,
        });
        const gone = res.status === 404 || res.status === 410;
        if (!res.ok && !gone) {
            log({ module: 'push', level: 'warn' }, `Web push non-OK ${res.status} for ${sub.endpoint}`);
        }
        return { ok: res.ok, statusCode: res.status, gone };
    } catch (error) {
        log({ module: 'push', level: 'error' }, `Web push send failed: ${error}`);
        return { ok: false, statusCode: 0, gone: false };
    }
}
