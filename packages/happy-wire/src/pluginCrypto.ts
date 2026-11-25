// B-974 Web plugins v1: hashing and HMAC signatures shared by the server, the
// daemon, the Web and third-party plugin code. Pure synchronous TypeScript
// (no `node:crypto`, no WebCrypto) so the same functions run in the browser
// bundle, the daemon and tests, and give byte-identical results everywhere.
// Equivalence with `node:crypto` is locked by `pluginCrypto.test.ts`.

const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export type PluginBytes = string | Uint8Array;

/** UTF-8 bytes of a string; a `Uint8Array` is used as is (raw body bytes). */
export function pluginBytes(input: PluginBytes): Uint8Array {
    return typeof input === 'string' ? new TextEncoder().encode(input) : input;
}

/** SHA-256 digest (32 bytes). */
export function pluginSha256(input: PluginBytes): Uint8Array {
    const data = pluginBytes(input);
    const bitLen = data.length * 8;
    const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
    padded.set(data);
    padded[data.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(bitLen / 0x1_0000_0000));
    view.setUint32(padded.length - 4, bitLen >>> 0);
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    for (let off = 0; off < padded.length; off += 64) {
        for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
        for (let i = 16; i < 64; i++) {
            const a = w[i - 15], b = w[i - 2];
            const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
            const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
        for (let i = 0; i < 64; i++) {
            const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            const ch = (e & f) ^ (~e & g);
            const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
            const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) >>> 0;
            hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
        h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]);
    return out;
}

export function pluginHex(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += b.toString(16).padStart(2, '0');
    return s;
}

export function pluginSha256Hex(input: PluginBytes): string {
    return pluginHex(pluginSha256(input));
}

/** HMAC-SHA256 (RFC 2104). */
export function pluginHmacSha256(key: PluginBytes, message: PluginBytes): Uint8Array {
    let k = pluginBytes(key);
    if (k.length > 64) k = pluginSha256(k);
    const ipad = new Uint8Array(64);
    const opad = new Uint8Array(64);
    for (let i = 0; i < 64; i++) {
        const b = i < k.length ? k[i] : 0;
        ipad[i] = b ^ 0x36;
        opad[i] = b ^ 0x5c;
    }
    const msg = pluginBytes(message);
    const inner = new Uint8Array(64 + msg.length);
    inner.set(ipad);
    inner.set(msg, 64);
    const innerHash = pluginSha256(inner);
    const outer = new Uint8Array(64 + 32);
    outer.set(opad);
    outer.set(innerHash, 64);
    return pluginSha256(outer);
}

export function pluginHmacSha256Hex(key: PluginBytes, message: PluginBytes): string {
    return pluginHex(pluginHmacSha256(key, message));
}

/** Length-independent comparison of two strings (no early exit on the first difference). */
export function pluginTimingSafeEqual(a: string, b: string): boolean {
    const x = pluginBytes(a), y = pluginBytes(b);
    let diff = x.length ^ y.length;
    const n = Math.max(x.length, y.length);
    for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
    return diff === 0;
}

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit order (the default
 * `Array.prototype.sort`), no whitespace, array order kept, `undefined`
 * properties dropped, numbers and strings as `JSON.stringify` writes them.
 * Non-finite numbers, functions, symbols, bigints and cyclic values throw.
 */
export function pluginCanonicalJson(value: unknown): string {
    const seen = new Set<object>();
    const walk = (v: unknown): string => {
        if (v === null) return 'null';
        switch (typeof v) {
            case 'string': case 'boolean': return JSON.stringify(v);
            case 'number':
                if (!Number.isFinite(v)) throw new Error('canonical JSON: non-finite number');
                return JSON.stringify(v);
            case 'object': {
                if (seen.has(v)) throw new Error('canonical JSON: cyclic value');
                seen.add(v);
                let out: string;
                if (Array.isArray(v)) {
                    out = `[${v.map(x => (x === undefined ? 'null' : walk(x))).join(',')}]`;
                } else {
                    const obj = v as Record<string, unknown>;
                    const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
                    out = `{${keys.map(k => `${JSON.stringify(k)}:${walk(obj[k])}`).join(',')}}`;
                }
                seen.delete(v);
                return out;
            }
            default:
                throw new Error(`canonical JSON: unsupported ${typeof v}`);
        }
    };
    return walk(value);
}

// ─── Signatures (DESIGN §5.5) ─────────────────────────────────────────────────

/** Signature scheme prefix in `X-VH-Signature: v1=<hex>`. */
export const PLUGIN_SIGNATURE_VERSION = 'v1';
/** Allowed clock skew between the signer and the verifier. */
export const PLUGIN_SIGNATURE_TOLERANCE_SEC = 300;

/**
 * The string an event delivery signs: `"v1:" + ts + ":" + eventId + ":" + rawBody`.
 * `rawBody` is the exact request body bytes (UTF-8 JSON as sent).
 */
export function pluginEventSigningInput(timestamp: number, eventId: string, rawBody: PluginBytes): Uint8Array {
    return concatBytes(pluginBytes(`v1:${timestamp}:${eventId}:`), pluginBytes(rawBody));
}

/** `X-VH-Signature` of an event delivery (push callback, and the `signature` of a pulled event). */
export function signPluginEvent(secret: string, timestamp: number, eventId: string, rawBody: PluginBytes): string {
    assertTimestamp(timestamp);
    return `${PLUGIN_SIGNATURE_VERSION}=${pluginHmacSha256Hex(secret, pluginEventSigningInput(timestamp, eventId, rawBody))}`;
}

/**
 * The string a forwarded panel request signs:
 * `"v1:" + ts + ":" + reqId + ":" + METHOD + ":" + pathWithQuery + ":" + sha256hex(body)`.
 * `method` is upper-cased; an absent body hashes as zero bytes.
 */
export function pluginRequestSigningInput(timestamp: number, requestId: string, method: string, pathWithQuery: string, body?: PluginBytes): string {
    return `v1:${timestamp}:${requestId}:${method.toUpperCase()}:${pathWithQuery}:${pluginSha256Hex(body ?? new Uint8Array(0))}`;
}

/** `X-VH-Signature` the daemon adds to a forwarded panel request (§4.6 step 6). */
export function signPluginRequest(secret: string, timestamp: number, requestId: string, method: string, pathWithQuery: string, body?: PluginBytes): string {
    assertTimestamp(timestamp);
    return `${PLUGIN_SIGNATURE_VERSION}=${pluginHmacSha256Hex(secret, pluginRequestSigningInput(timestamp, requestId, method, pathWithQuery, body))}`;
}

export type PluginSignatureCheck =
    | { ok: true }
    | { ok: false; reason: 'malformed' | 'stale' | 'mismatch' };

/** Check `X-VH-Timestamp` (unix seconds, as received) against `nowSec` with the ±300 s window. */
export function pluginTimestampFresh(timestampHeader: string | number, nowSec: number, toleranceSec = PLUGIN_SIGNATURE_TOLERANCE_SEC): number | null {
    const raw = String(timestampHeader);
    if (!/^\d{1,12}$/.test(raw)) return null;
    const ts = Number(raw);
    return Math.abs(nowSec - ts) <= toleranceSec ? ts : null;
}

/** Verify an event delivery. Callers still dedupe on `X-VH-Event-Id` (at-least-once delivery). */
export function verifyPluginEvent(args: { secret: string; signature: string | null | undefined; timestamp: string | number | null | undefined; eventId: string; rawBody: PluginBytes; nowSec: number }): PluginSignatureCheck {
    if (!args.signature || args.timestamp === null || args.timestamp === undefined || !args.eventId) return { ok: false, reason: 'malformed' };
    if (!/^\d{1,12}$/.test(String(args.timestamp))) return { ok: false, reason: 'malformed' };
    const ts = pluginTimestampFresh(args.timestamp, args.nowSec);
    if (ts === null) return { ok: false, reason: 'stale' };
    const expected = signPluginEvent(args.secret, ts, args.eventId, args.rawBody);
    return pluginTimingSafeEqual(expected, args.signature) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/** Verify a forwarded panel request (`X-VH-Request-Id`, `X-VH-Timestamp`, `X-VH-Signature`). */
export function verifyPluginRequest(args: { secret: string; signature: string | null | undefined; timestamp: string | number | null | undefined; requestId: string; method: string; pathWithQuery: string; body?: PluginBytes; nowSec: number }): PluginSignatureCheck {
    if (!args.signature || args.timestamp === null || args.timestamp === undefined || !args.requestId) return { ok: false, reason: 'malformed' };
    if (!/^\d{1,12}$/.test(String(args.timestamp))) return { ok: false, reason: 'malformed' };
    const ts = pluginTimestampFresh(args.timestamp, args.nowSec);
    if (ts === null) return { ok: false, reason: 'stale' };
    const expected = signPluginRequest(args.secret, ts, args.requestId, args.method, args.pathWithQuery, args.body);
    return pluginTimingSafeEqual(expected, args.signature) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

function assertTimestamp(ts: number): void {
    if (!Number.isSafeInteger(ts) || ts < 0) throw new Error('plugin signature timestamp must be a non-negative integer (unix seconds)');
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
}
