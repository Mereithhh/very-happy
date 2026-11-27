/**
 * B-980 model-request tagging (`specs/2026-11-model-feedback.md` §Tagging).
 *
 * A loopback HTTP forwarder in front of the session's model gateway. Every
 * request gets two headers whose names come from the operator's instance
 * config: the Very Happy session id, and a fresh request id. Ids are collected
 * until the current turn ends, then go out on the turn-end event, so a rating
 * on that answer joins the gateway's own request log exactly.
 *
 * Only the session's own Claude children see the loopback URL (they inherit
 * `ANTHROPIC_BASE_URL` from the wrapper env). Bodies are streamed both ways
 * untouched; the forwarder never reads, logs or stores them, nor the
 * credentials in the headers.
 */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { hostMatchesTagging, type ModelRequestTagging } from '@slopus/happy-wire';

/** Hop-by-hop headers (RFC 7230 §6.1) are never forwarded. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);

const MAX_IDS_PER_TURN = 200;

export interface RequestTagger {
    /** Base URL to give the agent instead of the upstream one. */
    baseUrl: string;
    /** Ids sent since the last call (one turn), oldest first. */
    takeRequestIds(): string[];
    close(): Promise<void>;
}

/** Pure: whether this upstream should be tagged under `config`. `always` = a global channel. */
export function shouldTagUpstream(upstream: string | undefined, config: ModelRequestTagging | null | undefined, always = false): boolean {
    if (!config || !upstream) return false;
    let url: URL;
    try {
        url = new URL(upstream);
    } catch {
        return false;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    return always || hostMatchesTagging(url.hostname, config.hosts);
}

/** Pure: upstream URL for an incoming path (the agent sees the loopback base with the same path prefix). */
export function upstreamUrl(upstream: URL, incomingPath: string): URL {
    const base = upstream.pathname.replace(/\/+$/, '');
    const [path, query] = incomingPath.split('?', 2) as [string, string | undefined];
    const out = new URL(upstream.origin);
    out.pathname = `${base}${path.startsWith('/') ? '' : '/'}${path}`;
    out.search = query ? `?${query}` : '';
    return out;
}

/** Pure: headers to send upstream (hop-by-hop dropped, host rewritten, tag headers set last so a client cannot spoof them). */
export function forwardHeaders(incoming: http.IncomingHttpHeaders, upstream: URL, tags: Record<string, string>): http.OutgoingHttpHeaders {
    const out: http.OutgoingHttpHeaders = {};
    const tagNames = new Set(Object.keys(tags).map(k => k.toLowerCase()));
    for (const [name, value] of Object.entries(incoming)) {
        const lower = name.toLowerCase();
        if (value === undefined || HOP_BY_HOP.has(lower) || tagNames.has(lower)) continue;
        out[lower] = value;
    }
    out.host = upstream.host;
    for (const [name, value] of Object.entries(tags)) out[name] = value;
    return out;
}

export async function startRequestTagger(opts: {
    upstream: string;
    sessionId: string;
    config: ModelRequestTagging;
    newRequestId?: () => string;
    onError?: (message: string) => void;
}): Promise<RequestTagger> {
    const upstream = new URL(opts.upstream);
    const client = upstream.protocol === 'https:' ? https : http;
    const agent = new client.Agent({ keepAlive: true, maxSockets: 32 });
    const newId = opts.newRequestId ?? randomUUID;
    let ids: string[] = [];
    const sockets = new Set<import('node:net').Socket>();

    const server = http.createServer((req, res) => {
        const requestId = newId();
        // Every request is tagged; only model calls (POST) count toward the turn — not reachability probes (HEAD/GET).
        if (req.method === 'POST' && ids.length < MAX_IDS_PER_TURN) ids.push(requestId);
        const target = upstreamUrl(upstream, req.url ?? '/');
        const headers = forwardHeaders(req.headers, upstream, {
            [opts.config.sessionHeader]: opts.sessionId,
            [opts.config.requestHeader]: requestId,
        });
        const out = client.request(target, { method: req.method, headers, agent }, (up) => {
            res.writeHead(up.statusCode ?? 502, up.statusMessage, up.headers);
            up.pipe(res);
        });
        out.on('error', (error) => {
            opts.onError?.(`upstream ${error.message}`);
            if (!res.headersSent) {
                res.writeHead(502, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Very Happy request tagger: upstream connection failed' } }));
            } else {
                res.destroy(error);
            }
        });
        // Client gave up (abort / interrupt): stop the upstream request too.
        res.on('close', () => { if (!res.writableFinished) out.destroy(); });
        req.pipe(out);
    });
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    server.headersTimeout = 60_000;
    server.requestTimeout = 0; // streaming answers can run long
    server.keepAliveTimeout = 30_000;

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = server.address() as AddressInfo;

    return {
        // No path: `upstreamUrl` puts the upstream's own prefix back on every request.
        baseUrl: `http://127.0.0.1:${port}`,
        takeRequestIds() {
            const taken = ids;
            ids = [];
            return taken;
        },
        async close() {
            agent.destroy();
            for (const s of sockets) s.destroy();
            await new Promise<void>(resolve => server.close(() => resolve()));
        },
    };
}
