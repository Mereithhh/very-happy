import { createHash, createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    PLUGIN_SECRET_BYTES,
    decodePluginSecret,
    encodePluginSecret,
    pluginCanonicalJson,
    pluginHmacSha256Hex,
    pluginSha256Hex,
    pluginTimingSafeEqual,
    signPluginEvent,
    signPluginRequest,
    verifyPluginEvent,
    verifyPluginRequest,
} from './pluginCrypto';

// Test vectors published in docs/plugin-api-v1.md. Changing any value here is a
// wire break for every plugin that verifies signatures.
const PLUGIN_SIGNATURE_VECTORS = {
    // `secret` file text = base64url of 32 × 0x01 (low-entropy on purpose: not a real key).
    secretFile: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE\n',
    secretHex: '01'.repeat(32),
    timestamp: 1795577286,
    event: {
        eventId: 'evt_01JTESTVECTOR0000000000000',
        rawBody: '{"id":"evt_01JTESTVECTOR0000000000000","type":"decision.responded","installId":"pi_test","pluginId":"hello-board","createdAt":1795577286598,"attempt":1,"data":{"itemId":"it_1","key":"count:5","action":"choose","choice":"continue","respondedAt":1795577286000,"actor":"owner"}}',
        signature: 'v1=020f2dc559ea6540094c4ad2adfc0cc55408f104ca8b96166a1738525874c737',
    },
    request: {
        requestId: 'req_01JTEST',
        method: 'POST',
        pathWithQuery: '/api/count?x=1',
        body: '{"delta":1}',
        bodySha256: '2c5f28bf1e8d3e071e067f175a8b6f728081245b9b8313a9cce44a5aeff3f246',
        signature: 'v1=60cf37275780ee4c721da0b4724d2fb8f872b474066d1b20bad20cb325708362',
    },
    requestGetNoBody: {
        requestId: 'req_01JTEST',
        method: 'GET',
        pathWithQuery: '/',
        signature: 'v1=44002e33ed4e7748d5813ea71d5e87e0bc28a38d6ea67022b3ae179d89891433',
    },
} as const;

const V = PLUGIN_SIGNATURE_VECTORS;
const KEY = decodePluginSecret(V.secretFile);
const nodeKey = () => Buffer.from(V.secretHex, 'hex');

describe('decodePluginSecret', () => {
    it('decodes the vector file text to 32 × 0x01', () => {
        expect(Buffer.from(KEY).toString('hex')).toBe(V.secretHex);
        expect(nodeKey().equals(Buffer.alloc(32, 1))).toBe(true);
        expect(decodePluginSecret('  AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE\r\n')).toEqual(KEY);
    });
    it('round-trips random secrets and matches node base64url', () => {
        for (let i = 0; i < 50; i++) {
            const b = randomBytes(32);
            expect(encodePluginSecret(new Uint8Array(b))).toBe(b.toString('base64url'));
            expect(Buffer.from(decodePluginSecret(b.toString('base64url') + '\n')).equals(b)).toBe(true);
        }
        expect(PLUGIN_SECRET_BYTES).toBe(32);
    });
    it('rejects prefixes, padding, wrong length, standard base64 and non-canonical tails', () => {
        const good = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE';
        for (const bad of [
            'vhs_' + good, good + '=', good.slice(0, 42), good + 'A', good.slice(0, 42) + '+', good.slice(0, 42) + '/',
            good.slice(0, 20) + ' ' + good.slice(20, 42), '', 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQF',
        ]) expect(() => decodePluginSecret(bad), JSON.stringify(bad)).toThrow();
        expect(() => decodePluginSecret(undefined as unknown as string)).toThrow(TypeError);
    });
    it('sign / verify refuse a text key', () => {
        expect(() => signPluginEvent(V.secretFile as unknown as Uint8Array, V.timestamp, 'e', '{}')).toThrow(TypeError);
        expect(() => signPluginRequest('k' as unknown as Uint8Array, V.timestamp, 'r', 'GET', '/')).toThrow(TypeError);
        expect(() => verifyPluginEvent({ secret: 'k' as unknown as Uint8Array, signature: 'v1=00', timestamp: V.timestamp, eventId: 'e', rawBody: '{}', nowSec: V.timestamp })).toThrow(TypeError);
    });
});

describe('pluginSha256 / pluginHmacSha256 match node:crypto', () => {
    it('sha256 for every length around the block boundaries', () => {
        for (let len = 0; len <= 200; len++) {
            const buf = randomBytes(len);
            expect(pluginSha256Hex(new Uint8Array(buf))).toBe(createHash('sha256').update(buf).digest('hex'));
        }
        expect(pluginSha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
        expect(pluginSha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
        const big = randomBytes(100_000);
        expect(pluginSha256Hex(new Uint8Array(big))).toBe(createHash('sha256').update(big).digest('hex'));
    });
    it('sha256 of strings is over UTF-8 bytes', () => {
        const s = '中文 ✓ emoji 🎉 "quotes"\n';
        expect(pluginSha256Hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
    });
    it('hmac for short, block-sized and long keys', () => {
        for (const keyLen of [0, 1, 32, 63, 64, 65, 200]) {
            for (const msgLen of [0, 1, 55, 56, 64, 300]) {
                const key = randomBytes(keyLen), msg = randomBytes(msgLen);
                expect(pluginHmacSha256Hex(new Uint8Array(key), new Uint8Array(msg))).toBe(createHmac('sha256', key).update(msg).digest('hex'));
            }
        }
        // RFC 4231 test case 2.
        expect(pluginHmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
    });
});

describe('signature test vectors (docs/plugin-api-v1.md)', () => {
    it('event delivery', () => {
        expect(signPluginEvent(KEY, V.timestamp, V.event.eventId, V.event.rawBody)).toBe(V.event.signature);
        // Independent recomputation with node:crypto, exactly as the docs describe it.
        const expected = 'v1=' + createHmac('sha256', nodeKey()).update(`v1:${V.timestamp}:${V.event.eventId}:${V.event.rawBody}`).digest('hex');
        expect(V.event.signature).toBe(expected);
        expect(signPluginEvent(KEY, V.timestamp, V.event.eventId, new TextEncoder().encode(V.event.rawBody))).toBe(V.event.signature);
    });
    it('forwarded panel request', () => {
        expect(pluginSha256Hex(V.request.body)).toBe(V.request.bodySha256);
        expect(signPluginRequest(KEY, V.timestamp, V.request.requestId, V.request.method, V.request.pathWithQuery, V.request.body)).toBe(V.request.signature);
        expect(signPluginRequest(KEY, V.timestamp, V.request.requestId, 'post', V.request.pathWithQuery, V.request.body)).toBe(V.request.signature);
        const expected = 'v1=' + createHmac('sha256', nodeKey()).update(`v1:${V.timestamp}:${V.request.requestId}:POST:${V.request.pathWithQuery}:${V.request.bodySha256}`).digest('hex');
        expect(V.request.signature).toBe(expected);
    });
    it('a request without a body hashes zero bytes', () => {
        const g = V.requestGetNoBody;
        expect(signPluginRequest(KEY, V.timestamp, g.requestId, g.method, g.pathWithQuery)).toBe(g.signature);
        expect(signPluginRequest(KEY, V.timestamp, g.requestId, g.method, g.pathWithQuery, '')).toBe(g.signature);
    });
    it('rejects non-integer timestamps', () => {
        expect(() => signPluginEvent(KEY, 1.5, 'e', '{}')).toThrow();
        expect(() => signPluginEvent(KEY, -1, 'e', '{}')).toThrow();
    });
});

describe('verifyPluginEvent', () => {
    const base = { secret: KEY, signature: V.event.signature, timestamp: String(V.timestamp), eventId: V.event.eventId, rawBody: V.event.rawBody, nowSec: V.timestamp + 10 };
    it('accepts the vector', () => {
        expect(verifyPluginEvent(base)).toEqual({ ok: true });
    });
    it('every signed component is bound (any single change fails)', () => {
        expect(verifyPluginEvent({ ...base, secret: decodePluginSecret('AgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE') })).toEqual({ ok: false, reason: 'mismatch' });
        expect(verifyPluginEvent({ ...base, eventId: V.event.eventId + 'x' })).toEqual({ ok: false, reason: 'mismatch' });
        expect(verifyPluginEvent({ ...base, rawBody: V.event.rawBody.replace('continue', 'reset') })).toEqual({ ok: false, reason: 'mismatch' });
        expect(verifyPluginEvent({ ...base, rawBody: V.event.rawBody + ' ' })).toEqual({ ok: false, reason: 'mismatch' });
        expect(verifyPluginEvent({ ...base, timestamp: String(V.timestamp + 1) })).toEqual({ ok: false, reason: 'mismatch' });
        const flipped = V.event.signature.slice(0, -1) + (V.event.signature.endsWith('0') ? '1' : '0');
        expect(verifyPluginEvent({ ...base, signature: flipped })).toEqual({ ok: false, reason: 'mismatch' });
        expect(verifyPluginEvent({ ...base, signature: V.event.signature.replace('v1=', 'v2=') })).toEqual({ ok: false, reason: 'mismatch' });
        expect(verifyPluginEvent({ ...base, signature: V.event.signature.slice(0, -2) })).toEqual({ ok: false, reason: 'mismatch' });
    });
    it('±300 s window, both directions, inclusive', () => {
        expect(verifyPluginEvent({ ...base, nowSec: V.timestamp + 300 })).toEqual({ ok: true });
        expect(verifyPluginEvent({ ...base, nowSec: V.timestamp - 300 })).toEqual({ ok: true });
        expect(verifyPluginEvent({ ...base, nowSec: V.timestamp + 301 })).toEqual({ ok: false, reason: 'stale' });
        expect(verifyPluginEvent({ ...base, nowSec: V.timestamp - 301 })).toEqual({ ok: false, reason: 'stale' });
    });
    it('missing or malformed headers', () => {
        expect(verifyPluginEvent({ ...base, signature: null })).toEqual({ ok: false, reason: 'malformed' });
        expect(verifyPluginEvent({ ...base, signature: '' })).toEqual({ ok: false, reason: 'malformed' });
        expect(verifyPluginEvent({ ...base, timestamp: undefined })).toEqual({ ok: false, reason: 'malformed' });
        expect(verifyPluginEvent({ ...base, timestamp: '1795577286.0' })).toEqual({ ok: false, reason: 'malformed' });
        expect(verifyPluginEvent({ ...base, timestamp: '-1' })).toEqual({ ok: false, reason: 'malformed' });
        expect(verifyPluginEvent({ ...base, eventId: '' })).toEqual({ ok: false, reason: 'malformed' });
    });
});

describe('verifyPluginRequest', () => {
    const r = V.request;
    const base = { secret: KEY, signature: r.signature, timestamp: V.timestamp, requestId: r.requestId, method: r.method, pathWithQuery: r.pathWithQuery, body: r.body, nowSec: V.timestamp };
    it('accepts the vector and binds method, path, query, body and request id', () => {
        expect(verifyPluginRequest(base)).toEqual({ ok: true });
        expect(verifyPluginRequest({ ...base, method: 'PUT' })).toEqual({ ok: false, reason: 'mismatch' });
        expect(verifyPluginRequest({ ...base, pathWithQuery: '/api/count' })).toEqual({ ok: false, reason: 'mismatch' });
        expect(verifyPluginRequest({ ...base, pathWithQuery: '/api/count?x=2' })).toEqual({ ok: false, reason: 'mismatch' });
        expect(verifyPluginRequest({ ...base, body: '{"delta":2}' })).toEqual({ ok: false, reason: 'mismatch' });
        expect(verifyPluginRequest({ ...base, body: undefined })).toEqual({ ok: false, reason: 'mismatch' });
        expect(verifyPluginRequest({ ...base, requestId: 'req_other' })).toEqual({ ok: false, reason: 'mismatch' });
        expect(verifyPluginRequest({ ...base, nowSec: V.timestamp + 301 })).toEqual({ ok: false, reason: 'stale' });
    });
});

describe('pluginTimingSafeEqual', () => {
    it('compares full content and length', () => {
        expect(pluginTimingSafeEqual('abc', 'abc')).toBe(true);
        expect(pluginTimingSafeEqual('abc', 'abd')).toBe(false);
        expect(pluginTimingSafeEqual('abc', 'abcd')).toBe(false);
        expect(pluginTimingSafeEqual('', '')).toBe(true);
        expect(pluginTimingSafeEqual('a', '')).toBe(false);
        // Equal prefix padded with NUL must still differ (length is part of the comparison).
        expect(pluginTimingSafeEqual('a', 'a\u0000')).toBe(false);
    });
});

describe('pluginCanonicalJson', () => {
    it('sorts keys recursively, keeps array order, drops undefined, no whitespace', () => {
        expect(pluginCanonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' }, u: undefined })).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
        expect(pluginCanonicalJson([undefined, null, true, 1.5, '中'])).toBe('[null,null,true,1.5,"中"]');
        expect(pluginCanonicalJson({ B: 1, a: 2, _: 3 })).toBe('{"B":1,"_":3,"a":2}');
    });
    it('throws on values JSON cannot represent canonically', () => {
        expect(() => pluginCanonicalJson({ n: Number.NaN })).toThrow();
        expect(() => pluginCanonicalJson({ n: Infinity })).toThrow();
        expect(() => pluginCanonicalJson({ f: () => 1 })).toThrow();
        const cyc: Record<string, unknown> = {}; cyc.self = cyc;
        expect(() => pluginCanonicalJson(cyc)).toThrow();
    });
    it('shared (non-cyclic) references are fine', () => {
        const shared = { a: 1 };
        expect(pluginCanonicalJson({ x: shared, y: shared })).toBe('{"x":{"a":1},"y":{"a":1}}');
    });
});
