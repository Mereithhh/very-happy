/**
 * B-974c: the two HMAC-SHA256 signatures a plugin backend can check
 * (DESIGN §5.5). Draft of the wire helpers (B-974a); same strings.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const PLUGIN_TOKEN_PREFIX = 'vhp_';

/** `vhp_` + 32 random bytes, base64url (§2.2). */
export function createPluginToken(): string {
    return PLUGIN_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

/** 32 random bytes, stored base64url; the HMAC key is the decoded bytes. */
export function createPluginSecret(): string {
    return randomBytes(32).toString('base64url');
}

export function secretKeyBytes(secret: string): Buffer {
    return Buffer.from(secret.trim(), 'base64url');
}

const hmacHex = (secret: string, message: string | Buffer) => createHmac('sha256', secretKeyBytes(secret)).update(message).digest('hex');

/** Event push / pull: `v1=hex(HMAC(secret, "v1:" + ts + ":" + eventId + ":" + rawBody))`. */
export function signEvent(secret: string, timestampSec: number, eventId: string, rawBody: string): string {
    return `v1=${hmacHex(secret, Buffer.concat([Buffer.from(`v1:${timestampSec}:${eventId}:`, 'utf8'), Buffer.from(rawBody, 'utf8')]))}`;
}

/** Panel forwarding: `v1=hex(HMAC(secret, "v1:" + ts + ":" + reqId + ":" + METHOD + ":" + pathWithQuery + ":" + sha256hex(body)))`. */
export function signPanelRequest(secret: string, timestampSec: number, reqId: string, method: string, pathWithQuery: string, body: Buffer): string {
    const bodyHash = createHash('sha256').update(body).digest('hex');
    return `v1=${hmacHex(secret, `v1:${timestampSec}:${reqId}:${method.toUpperCase()}:${pathWithQuery}:${bodyHash}`)}`;
}

/** Reference verifier (what a plugin does, §5.5): constant time, ±300 s. */
export function verifyEventSignature(secret: string, header: string | undefined, timestampSec: number, eventId: string, rawBody: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
    if (typeof header !== 'string' || !Number.isFinite(timestampSec)) return false;
    if (Math.abs(nowSec - timestampSec) > 300) return false;
    const expected = Buffer.from(signEvent(secret, timestampSec, eventId, rawBody), 'utf8');
    const got = Buffer.from(header, 'utf8');
    return got.length === expected.length && timingSafeEqual(got, expected);
}
