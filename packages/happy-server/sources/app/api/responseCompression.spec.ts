import * as zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import {
    COMPRESSION_MIN_BYTES,
    enableResponseCompression,
    isCompressibleResponse,
    pickResponseEncoding,
    responseCompressionEnabled,
} from './responseCompression';

// Base64 of random bytes, like a session list's encrypted metadata (fixed per run).
const BIG = { sessions: Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, metadata: Buffer.from(Array.from({ length: 600 }, () => Math.floor(Math.random() * 256))).toString('base64') })) };
const bigJson = () => BIG;

async function appWithRoutes() {
    const app = Fastify();
    enableResponseCompression(app);
    app.get('/big', async () => bigJson());
    app.get('/small', async () => ({ ok: true }));
    app.get('/html', async (_req, reply) => reply.type('text/html').send('<p>' + 'x'.repeat(COMPRESSION_MIN_BYTES * 4) + '</p>'));
    app.get('/encoded', async (_req, reply) => reply.header('content-encoding', 'gzip').type('application/json').send(zlib.gzipSync(JSON.stringify(bigJson()))));
    await app.ready();
    return app;
}

describe('B-818 response compression', () => {
    it('picks br over gzip, honours q=0 and *', () => {
        expect(pickResponseEncoding('gzip, deflate, br, zstd')).toBe('br');
        expect(pickResponseEncoding('gzip')).toBe('gzip');
        expect(pickResponseEncoding('br;q=0, gzip;q=0.5')).toBe('gzip');
        expect(pickResponseEncoding('br;q=0, gzip;q=0')).toBeNull();
        expect(pickResponseEncoding('identity')).toBeNull();
        expect(pickResponseEncoding('*')).toBe('br');
        expect(pickResponseEncoding('*, br;q=0')).toBe('gzip');
        expect(pickResponseEncoding(undefined)).toBeNull();
        expect(pickResponseEncoding('')).toBeNull();
    });

    it('only serialized JSON of at least COMPRESSION_MIN_BYTES, not already encoded', () => {
        const big = 'x'.repeat(COMPRESSION_MIN_BYTES);
        expect(isCompressibleResponse('application/json; charset=utf-8', big, undefined)).toBe(true);
        expect(isCompressibleResponse('application/problem+json', Buffer.from(big), undefined)).toBe(true);
        expect(isCompressibleResponse('application/json', big.slice(1), undefined)).toBe(false);
        expect(isCompressibleResponse('text/html', big, undefined)).toBe(false);
        expect(isCompressibleResponse('application/json', big, 'gzip')).toBe(false);
        expect(isCompressibleResponse('application/json', { pipe() {} }, undefined)).toBe(false);
    });

    it('the kill switch', () => {
        expect(responseCompressionEnabled({})).toBe(true);
        for (const off of ['off', 'OFF', '0', 'false']) expect(responseCompressionEnabled({ HTTP_COMPRESSION: off })).toBe(false);
        expect(responseCompressionEnabled({ HTTP_COMPRESSION: 'on' })).toBe(true);
    });

    it('a big JSON response goes out br (or gzip) and decodes to the same body', async () => {
        const app = await appWithRoutes();
        try {
            const plain = await app.inject({ url: '/big' });
            expect(plain.headers['content-encoding']).toBeUndefined();
            expect(plain.headers.vary).toContain('Accept-Encoding');
            const br = await app.inject({ url: '/big', headers: { 'accept-encoding': 'gzip, deflate, br' } });
            expect(br.headers['content-encoding']).toBe('br');
            expect(br.headers.vary).toContain('Accept-Encoding');
            expect(Number(br.headers['content-length'])).toBe(br.rawPayload.length);
            expect(br.rawPayload.length).toBeLessThan(plain.rawPayload.length * 0.85);
            expect(JSON.parse(zlib.brotliDecompressSync(br.rawPayload).toString())).toEqual(JSON.parse(plain.body));
            const gz = await app.inject({ url: '/big', headers: { 'accept-encoding': 'gzip' } });
            expect(gz.headers['content-encoding']).toBe('gzip');
            expect(JSON.parse(zlib.gunzipSync(gz.rawPayload).toString())).toEqual(JSON.parse(plain.body));
        } finally { await app.close(); }
    });

    it('small JSON, HTML and already-encoded bodies pass through', async () => {
        const app = await appWithRoutes();
        try {
            const headers = { 'accept-encoding': 'br, gzip' };
            expect((await app.inject({ url: '/small', headers })).headers['content-encoding']).toBeUndefined();
            expect((await app.inject({ url: '/html', headers })).headers['content-encoding']).toBeUndefined();
            const encoded = await app.inject({ url: '/encoded', headers });
            expect(encoded.headers['content-encoding']).toBe('gzip');
            expect(JSON.parse(zlib.gunzipSync(encoded.rawPayload).toString()).sessions).toHaveLength(40);
        } finally { await app.close(); }
    });
});
