// Reference verification for Very Happy plugin signatures (vh-plugin/v1).
// Zero dependencies; copy this file into your plugin. Spec: docs/plugin-api-v1.md#signatures

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const TOLERANCE_SEC = 300;

/**
 * The `secret` file holds 32 random bytes as unpadded base64url (43 characters,
 * maybe a trailing newline). Those decoded bytes are the HMAC key; never use
 * the text itself as the key.
 */
export function decodeSecret(fileText) {
    const t = String(fileText ?? '').trim();
    const key = /^[A-Za-z0-9_-]{43}$/.test(t) ? Buffer.from(t, 'base64url') : null;
    if (!key || key.length !== 32 || key.toString('base64url') !== t) throw new Error('secret file must hold 32 bytes as unpadded base64url');
    return key;
}

function assertKey(key) {
    if (!Buffer.isBuffer(key) && !(key instanceof Uint8Array)) throw new TypeError('pass the decoded secret (decodeSecret), not the file text');
}

function safeEqual(a, b) {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && timingSafeEqual(x, y);
}

function freshTimestamp(header, nowSec) {
    if (!/^\d{1,12}$/.test(String(header ?? ''))) return null;
    const ts = Number(header);
    return Math.abs(nowSec - ts) <= TOLERANCE_SEC ? ts : null;
}

/** Signature of an event: v1=hex(HMAC-SHA256(key, "v1:" + ts + ":" + eventId + ":" + rawBody)). */
export function signEvent(key, ts, eventId, rawBody) {
    assertKey(key);
    return 'v1=' + createHmac('sha256', key).update(`v1:${ts}:${eventId}:`).update(rawBody).digest('hex');
}

/** Signature of a forwarded panel request: v1=hex(HMAC(key, "v1:" + ts + ":" + reqId + ":" + METHOD + ":" + pathWithQuery + ":" + sha256hex(body))). */
export function signRequest(key, ts, reqId, method, pathWithQuery, body = Buffer.alloc(0)) {
    assertKey(key);
    const bodyHash = createHash('sha256').update(body).digest('hex');
    return 'v1=' + createHmac('sha256', key).update(`v1:${ts}:${reqId}:${method.toUpperCase()}:${pathWithQuery}:${bodyHash}`).digest('hex');
}

/**
 * Verify a pushed event (POST to your callback URL). `rawBody` must be the exact
 * bytes received, before JSON.parse. Returns true or false; dedupe on the event
 * id yourself (delivery is at-least-once).
 */
export function verifyEvent({ key, headers, rawBody, nowSec = Math.floor(Date.now() / 1000) }) {
    if (!key) return false;
    const ts = freshTimestamp(headers['x-vh-timestamp'], nowSec);
    const eventId = headers['x-vh-event-id'];
    const sig = headers['x-vh-signature'];
    if (ts === null || !eventId || !sig) return false;
    return safeEqual(signEvent(key, ts, eventId, rawBody), sig);
}

/** Verify that a panel request was forwarded by Very Happy (owner is viewing). */
export function verifyRequest({ key, method, pathWithQuery, headers, body, nowSec = Math.floor(Date.now() / 1000) }) {
    if (!key) return false;
    const ts = freshTimestamp(headers['x-vh-timestamp'], nowSec);
    const reqId = headers['x-vh-request-id'];
    const sig = headers['x-vh-signature'];
    if (ts === null || !reqId || !sig) return false;
    return safeEqual(signRequest(key, ts, reqId, method, pathWithQuery, body), sig);
}

/** Remembers event ids for 10 minutes so a redelivered event is acknowledged but not applied twice. */
export function createDedupe(ttlMs = 10 * 60 * 1000) {
    const seen = new Map();
    return (id, now = Date.now()) => {
        for (const [k, t] of seen) if (now - t > ttlMs) seen.delete(k);
        if (seen.has(id)) return false;
        seen.set(id, now);
        return true;
    };
}
