/**
 * B-974c: the only way plugin code paths open a TCP connection. The target is
 * a loopback IP literal taken from an approved manifest; the socket is opened
 * with `net.connect` on that literal (no DNS: `lookup` refuses), the request
 * never goes through an agent or proxy env (`HTTP_PROXY` is not read by
 * `node:http`, and no agent is involved), and redirects are never followed.
 */
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { connect, isIP, type LookupFunction } from 'node:net';

export type LoopbackTarget = { host: '127.0.0.1' | '::1'; port: number };

const refuseLookup: LookupFunction = (hostname, _options, callback) => {
    const error = Object.assign(new Error(`DNS lookup refused for ${hostname}`), { code: 'EDNSREFUSED' });
    (callback as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(error, '', 0);
};

/** Only the two loopback literals pass; anything else is a programming error. */
export function assertLoopbackTarget(target: { host: string; port: number }): asserts target is LoopbackTarget {
    if ((target.host !== '127.0.0.1' && target.host !== '::1') || isIP(target.host) === 0) throw new Error(`refusing non-loopback target ${target.host}`);
    if (!Number.isInteger(target.port) || target.port < 1024 || target.port > 65535) throw new Error(`refusing port ${target.port}`);
}

export function authorityOf(target: LoopbackTarget): string {
    return target.host === '::1' ? `[::1]:${target.port}` : `127.0.0.1:${target.port}`;
}

export type LoopbackResponse = { status: number; headers: IncomingHttpHeaders; rawHeaders: string[]; body: IncomingMessage };

/**
 * Send one request. Resolves when response headers arrive; the caller owns
 * `body` (read or destroy it). `timeoutMs` covers connect + headers.
 */
export function loopbackRequest(target: LoopbackTarget, opts: {
    method: string;
    path: string;
    headers: Record<string, string | string[]>;
    body?: Buffer;
    timeoutMs: number;
    signal?: AbortSignal;
}): Promise<LoopbackResponse> {
    assertLoopbackTarget(target);
    return new Promise((resolve, reject) => {
        let settled = false;
        const req = httpRequest({
            method: opts.method,
            path: opts.path,
            headers: opts.headers,
            setHost: false,
            createConnection: () => connect({ host: target.host, port: target.port, lookup: refuseLookup }),
            signal: opts.signal,
        });
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            req.destroy(Object.assign(new Error('upstream timeout'), { code: 'UPSTREAM_TIMEOUT' }));
            reject(Object.assign(new Error('upstream timeout'), { code: 'UPSTREAM_TIMEOUT' }));
        }, opts.timeoutMs);
        req.on('response', (res) => {
            clearTimeout(timer);
            if (settled) { res.destroy(); return; }
            settled = true;
            resolve({ status: res.statusCode ?? 502, headers: res.headers, rawHeaders: res.rawHeaders, body: res });
        });
        req.on('error', (error) => {
            clearTimeout(timer);
            if (settled) return;
            settled = true;
            reject(error);
        });
        if (opts.body && opts.body.length > 0) req.end(opts.body); else req.end();
    });
}

/** Read a body fully, up to `maxBytes` (then destroy and throw). */
export async function readBody(body: IncomingMessage, maxBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of body) {
        total += (chunk as Buffer).length;
        if (total > maxBytes) { body.destroy(); throw Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' }); }
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
}
