import { promisify } from 'node:util';
import * as zlib from 'node:zlib';
import type { FastifyInstance } from 'fastify';

/**
 * B-818: compress JSON API responses (B-816 Q1).
 *
 * Nothing on the path compressed them: CloudFront's default behavior has
 * `Compress=false` (Managed-CachingDisabled; it forwards the viewer's
 * Accept-Encoding through the AllViewer origin request policy and passes an
 * encoded body through untouched), and Caddy and Fastify had no encoder. The
 * biggest account's `/v1/sessions` is ~1.8MB of base64 ciphertext; on slow 4G
 * that alone is ~9s. Done here so it ships and rolls back with the image.
 *
 * Only JSON bodies already serialized to a string/Buffer (every API route);
 * streams (files, static assets, which CloudFront's `/assets/*` behavior
 * compresses), HTML and anything already encoded pass through. Brotli at a
 * low quality (fast, ~gzip-6 cost) when offered, else gzip. Async zlib runs on
 * the libuv pool, off the event loop. `HTTP_COMPRESSION=off` disables it.
 */

export const COMPRESSION_MIN_BYTES = 1024;
const BROTLI_QUALITY = 4;
const GZIP_LEVEL = 6;

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

export type ResponseEncoding = 'br' | 'gzip';

/**
 * The encoding to use for a request's `Accept-Encoding`, or null. Honours
 * `q=0` (refused) and picks br over gzip whenever both are acceptable;
 * `*` accepts br.
 */
export function pickResponseEncoding(acceptEncoding: string | string[] | undefined): ResponseEncoding | null {
    const raw = Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : acceptEncoding;
    if (!raw) return null;
    const q = new Map<string, number>();
    for (const part of raw.split(',')) {
        const [name, ...params] = part.trim().toLowerCase().split(';');
        if (!name) continue;
        let weight = 1;
        for (const param of params) {
            const match = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(param);
            if (match) weight = Number(match[1]);
        }
        q.set(name, Number.isFinite(weight) ? weight : 0);
    }
    const accepts = (name: ResponseEncoding) => (q.get(name) ?? q.get('*') ?? 0) > 0;
    if (accepts('br')) return 'br';
    if (accepts('gzip')) return 'gzip';
    return null;
}

/** Whether a response with this content type and serialized payload is worth compressing. */
export function isCompressibleResponse(contentType: unknown, payload: unknown, contentEncoding: unknown): payload is string | Buffer {
    if (contentEncoding !== undefined && contentEncoding !== 'identity') return false;
    if (typeof contentType !== 'string' || !/^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType)) return false;
    const size = typeof payload === 'string' ? Buffer.byteLength(payload) : Buffer.isBuffer(payload) ? payload.length : -1;
    return size >= COMPRESSION_MIN_BYTES;
}

export async function compressPayload(payload: string | Buffer, encoding: ResponseEncoding): Promise<Buffer> {
    const input = typeof payload === 'string' ? Buffer.from(payload) : payload;
    return encoding === 'br'
        ? brotli(input, {
            params: {
                [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
                [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
                [zlib.constants.BROTLI_PARAM_SIZE_HINT]: input.length,
            },
        })
        : gzip(input, { level: GZIP_LEVEL });
}

export function responseCompressionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = env.HTTP_COMPRESSION?.trim().toLowerCase();
    return !(raw === 'off' || raw === '0' || raw === 'false');
}

function appendVary(current: unknown, value: string): string {
    const list = (Array.isArray(current) ? current.join(',') : typeof current === 'string' ? current : '')
        .split(',').map((v) => v.trim()).filter(Boolean);
    if (list.includes('*') || list.some((v) => v.toLowerCase() === value.toLowerCase())) return list.join(', ');
    return [...list, value].join(', ');
}

/** Register the onSend hook (api.ts, before the routes). Any server/logger flavour: api.ts uses a pino child logger. */
export function enableResponseCompression(app: FastifyInstance<any, any, any, any, any>) {
    if (!responseCompressionEnabled()) return;
    app.addHook('onSend', async (request, reply, payload) => {
        if (!isCompressibleResponse(reply.getHeader('content-type'), payload, reply.getHeader('content-encoding'))) return payload;
        // The body depends on Accept-Encoding whether or not this one is encoded.
        reply.header('vary', appendVary(reply.getHeader('vary'), 'Accept-Encoding'));
        const encoding = pickResponseEncoding(request.headers['accept-encoding']);
        if (!encoding) return payload;
        const compressed = await compressPayload(payload, encoding);
        reply.header('content-encoding', encoding);
        reply.removeHeader('content-length');
        return compressed;
    });
}
