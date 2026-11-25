/**
 * B-974c: the daemon side of panel forwarding — `plugin-http`,
 * `plugin-http-body`, `plugin-http-pull` machine RPCs (DESIGN §4.5, §4.6).
 *
 * The target comes only from the approved manifest (by panelId); requests
 * carry no address. Order of checks follows §4.6.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { parseLoopbackUrl } from './manifest';
import { checkAccess, type PluginRegistry } from './registry';
import { normalizePluginRequestPath, signPluginRequest } from '@slopus/happy-wire';
import { authorityOf, loopbackRequest, type LoopbackTarget } from './loopbackHttp';

export const INLINE_BODY_MAX = 256 * 1024;
export const CHUNK_MAX = 512 * 1024;
export const REQUEST_BODY_MAX = 8 * 1024 * 1024;
export const RESPONSE_BODY_MAX = 32 * 1024 * 1024;
export const UPSTREAM_TIMEOUT_MS = 25_000;
export const MAX_CONCURRENT_PER_INSTALL = 16;
const STREAM_IDLE_MS = 30_000;

export type PluginHttpRequest = {
    reqId: string;
    installId: string;
    panelId: string;
    method: string;
    path: string;
    query?: string;
    headers?: Record<string, string | string[]>;
    bodyB64?: string;
    bodyStreamId?: string;
};
export type PluginHttpResponse = { status: number; headers: Record<string, string | string[]>; bodyB64: string; streamId?: string };

const jsonError = (status: number, error: string, message: string, extra: Record<string, unknown> = {}): PluginHttpResponse => ({
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    bodyB64: Buffer.from(JSON.stringify({ error, message, ...extra })).toString('base64'),
});

// ── path ────────────────────────────────────────────────────────────────────

/**
 * §4.6 step 3: the wire rule (`normalizePluginRequestPath`: leading `/`, no
 * `//host` / `scheme:`, no `\\` / NUL / control chars raw or encoded, no `.` /
 * `..` segment after decoding) plus two local limits: `path` carries no `?` /
 * `#` (the query has its own field), and neither part carries whitespace or a
 * fragment. The original (still encoded) path is what gets forwarded.
 */
export function normalizeForwardPath(path: unknown, query: unknown): { ok: true; pathWithQuery: string } | { ok: false } {
    if (typeof path !== 'string' || /[\s#?]/.test(path)) return { ok: false };
    let q = '';
    if (query !== undefined && query !== null && query !== '') {
        if (typeof query !== 'string' || query.length > 8192 || /[\s#]/.test(query)) return { ok: false };
        q = query.startsWith('?') ? query : `?${query}`;
    }
    const normalized = normalizePluginRequestPath(path + q);
    return normalized === null ? { ok: false } : { ok: true, pathWithQuery: normalized };
}

// ── headers ────────────────────────────────────────────────────────────────

const HOP_BY_HOP = new Set(['connection', 'upgrade', 'te', 'transfer-encoding', 'keep-alive', 'trailer', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'host', 'content-length', 'forwarded', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip']);

function isInternalHeader(name: string): boolean {
    return name.startsWith('x-vh-') || name.startsWith('x-happy-') || name.startsWith('proxy-');
}

/** Drop `__Host-vhp*` cookies (the host's frame session), keep the plugin's own. */
export function stripHostCookies(cookie: string): string {
    return cookie.split(';').map((c) => c.trim()).filter((c) => c.length > 0 && !c.startsWith('__Host-vhp')).join('; ');
}

/** The plugin subdomain the browser used, when it is this plugin's (`<pluginId>-<h8>.<pluginHost>`). */
export function pluginSubdomain(pluginId: string, host: string | undefined): string | null {
    if (typeof host !== 'string') return null;
    const h = host.trim().toLowerCase();
    if (!h.startsWith(`${pluginId}-`) || !/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/.test(h)) return null;
    return h;
}

export function buildUpstreamHeaders(inbound: Record<string, string | string[] | undefined>, ctx: {
    target: LoopbackTarget;
    pluginId: string;
    signature: Record<string, string>;
}): Record<string, string | string[]> {
    const lower: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(inbound)) if (v !== undefined) lower[k.toLowerCase()] = v;
    const connectionListed = new Set(String(lower['connection'] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    const subdomain = pluginSubdomain(ctx.pluginId, typeof lower['host'] === 'string' ? lower['host'] : undefined);
    const pluginOrigin = subdomain ? `https://${subdomain}` : null;
    const authority = authorityOf(ctx.target);
    const out: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(lower)) {
        if (HOP_BY_HOP.has(name) || connectionListed.has(name) || isInternalHeader(name)) continue;
        if (name === 'cookie') {
            const kept = stripHostCookies(Array.isArray(value) ? value.join('; ') : value);
            if (kept) out.cookie = kept;
            continue;
        }
        if (name === 'origin') {
            if (pluginOrigin && value === pluginOrigin) out.origin = `http://${authority}`;
            continue;
        }
        if (name === 'referer') {
            if (pluginOrigin && typeof value === 'string' && (value === pluginOrigin || value.startsWith(`${pluginOrigin}/`))) out.referer = `http://${authority}${value.slice(pluginOrigin.length) || '/'}`;
            continue;
        }
        out[name] = value;
    }
    out.host = authority;
    out['x-forwarded-proto'] = 'https';
    if (subdomain) out['x-forwarded-host'] = subdomain;
    for (const [k, v] of Object.entries(ctx.signature)) out[k.toLowerCase()] = v;
    return out;
}

/** §4.6 step 5: a redirect back to the upstream becomes a path on the plugin subdomain. */
export function rewriteLocation(location: string, target: LoopbackTarget): string {
    let url: URL;
    try { url = new URL(location); } catch { return location; }
    if (url.protocol !== 'http:' || url.username || url.password) return location;
    const port = url.port === '' ? 80 : Number(url.port);
    const sameHost = target.host === '::1' ? url.hostname === '[::1]' : url.hostname === '127.0.0.1';
    if (!sameHost || port !== target.port) return location;
    return `${url.pathname}${url.search}${url.hash}`;
}

const RESPONSE_DROP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-connection', 'content-length']);

export function filterResponseHeaders(headers: Record<string, string | string[] | undefined>, target: LoopbackTarget): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(headers)) {
        const name = k.toLowerCase();
        if (v === undefined || RESPONSE_DROP.has(name) || name.startsWith('x-vh-')) continue;
        out[name] = name === 'location' && typeof v === 'string' ? rewriteLocation(v, target) : v;
    }
    return out;
}

// ── streams ────────────────────────────────────────────────────────────────

type BodyUpload = { installId: string; chunks: Buffer[]; total: number; nextSeq: number; ended: boolean; timer: NodeJS.Timeout };
type ResponseStream = { installId: string; body: IncomingMessage; nextSeq: number; total: number; timer: NodeJS.Timeout; release: () => void };

/** Pull up to `max` bytes from a paused response; `end` when nothing is left. */
async function readChunk(body: IncomingMessage, max: number, timeoutMs: number): Promise<{ chunk: Buffer; end: boolean }> {
    const parts: Buffer[] = [];
    let size = 0;
    return new Promise((resolve, reject) => {
        let done = false;
        const finish = (end: boolean) => {
            if (done) return;
            done = true;
            cleanup();
            resolve({ chunk: Buffer.concat(parts), end });
        };
        const onReadable = () => {
            let piece: Buffer | null;
            while (size < max && (piece = body.read(Math.min(max - size, CHUNK_MAX)) as Buffer | null) !== null) {
                parts.push(piece);
                size += piece.length;
            }
            if (size >= max) finish(false);
        };
        const onEnd = () => finish(true);
        const onError = (e: Error) => { if (done) return; done = true; cleanup(); reject(e); };
        const timer = setTimeout(() => (size > 0 ? finish(false) : onError(Object.assign(new Error('chunk timeout'), { code: 'UPSTREAM_TIMEOUT' }))), timeoutMs);
        const cleanup = () => {
            clearTimeout(timer);
            body.off('readable', onReadable);
            body.off('end', onEnd);
            body.off('error', onError);
        };
        if (body.readableEnded) { finish(true); return; }
        body.on('readable', onReadable);
        body.on('end', onEnd);
        body.on('error', onError);
        onReadable();
    });
}

// ── forwarder ──────────────────────────────────────────────────────────────

export class PluginHttpForwarder {
    private uploads = new Map<string, BodyUpload>();
    private streams = new Map<string, ResponseStream>();
    private inFlight = new Map<string, number>();

    constructor(private readonly registry: PluginRegistry, private readonly opts: { timeoutMs?: number; now?: () => number } = {}) {}

    /** `plugin-http-body { streamId, seq, chunkB64, end }`: body chunks arrive before `plugin-http`. */
    acceptBodyChunk(params: { installId?: string; streamId?: string; seq?: number; chunkB64?: string; end?: boolean }): { ok: true } | { error: string } {
        const { streamId, installId } = params;
        if (typeof streamId !== 'string' || streamId.length === 0 || streamId.length > 128 || typeof installId !== 'string') return { error: 'invalid_request' };
        const chunk = typeof params.chunkB64 === 'string' ? Buffer.from(params.chunkB64, 'base64') : Buffer.alloc(0);
        if (chunk.length > CHUNK_MAX) return { error: 'payload_too_large' };
        let upload = this.uploads.get(streamId);
        if (!upload) {
            if (params.seq !== 0) return { error: 'invalid_request' };
            upload = { installId, chunks: [], total: 0, nextSeq: 0, ended: false, timer: setTimeout(() => this.uploads.delete(streamId), 60_000) };
            upload.timer.unref?.();
            this.uploads.set(streamId, upload);
        }
        if (upload.installId !== installId || upload.ended || params.seq !== upload.nextSeq) return { error: 'invalid_request' };
        upload.total += chunk.length;
        if (upload.total > REQUEST_BODY_MAX) { clearTimeout(upload.timer); this.uploads.delete(streamId); return { error: 'payload_too_large' }; }
        upload.chunks.push(chunk);
        upload.nextSeq++;
        if (params.end) upload.ended = true;
        return { ok: true };
    }

    async handle(req: PluginHttpRequest): Promise<PluginHttpResponse> {
        const entry = typeof req?.installId === 'string' ? this.registry.byInstallId(req.installId) : undefined;
        if (!entry) return jsonError(404, 'not_found', 'unknown install');
        const denied = checkAccess(entry, { allOf: ['panel'] });
        if (denied) return jsonError(denied.status, denied.error, denied.message, denied.permission ? { permission: denied.permission } : {});
        // 1. target only from the approved manifest.
        const panel = entry.manifest!.panels?.find((p) => p.id === req.panelId);
        if (!panel) return jsonError(404, 'not_found', 'unknown panel');
        const upstream = parseLoopbackUrl(panel.upstream, false);
        if (!upstream) return jsonError(502, 'upstream_unreachable', 'upstream is not a loopback address');
        const target: LoopbackTarget = { host: upstream.host, port: upstream.port };
        // 3. path
        const normalized = normalizeForwardPath(req.path, req.query);
        if (!normalized.ok) return jsonError(400, 'invalid_path', 'path is not allowed');
        const method = typeof req.method === 'string' ? req.method.toUpperCase() : '';
        if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method)) return jsonError(400, 'invalid_request', 'method not allowed');
        const inbound = req.headers && typeof req.headers === 'object' ? req.headers : {};
        const lowerKeys = Object.fromEntries(Object.entries(inbound).map(([k, v]) => [k.toLowerCase(), v]));
        const connection = String(lowerKeys['connection'] ?? '').toLowerCase();
        if (lowerKeys['upgrade'] !== undefined || connection.split(',').map((s) => s.trim()).includes('upgrade')) return jsonError(501, 'unsupported_upgrade', 'WebSocket upgrades are not forwarded in v1');
        // body
        let body: Buffer;
        if (typeof req.bodyStreamId === 'string') {
            const upload = this.uploads.get(req.bodyStreamId);
            if (!upload || upload.installId !== entry.record.installId || !upload.ended) return jsonError(400, 'invalid_request', 'request body stream incomplete');
            clearTimeout(upload.timer);
            this.uploads.delete(req.bodyStreamId);
            body = Buffer.concat(upload.chunks);
        } else {
            body = typeof req.bodyB64 === 'string' ? Buffer.from(req.bodyB64, 'base64') : Buffer.alloc(0);
            if (body.length > INLINE_BODY_MAX) return jsonError(413, 'payload_too_large', 'inline body over 256KB');
        }
        // 7. concurrency
        const installId = entry.record.installId;
        const running = this.inFlight.get(installId) ?? 0;
        if (running >= MAX_CONCURRENT_PER_INSTALL) return jsonError(429, 'rate_limited', 'too many concurrent requests', { retryAfterMs: 500 });
        this.inFlight.set(installId, running + 1);
        let released = false;
        const release = () => { if (released) return; released = true; this.inFlight.set(installId, Math.max(0, (this.inFlight.get(installId) ?? 1) - 1)); };
        // 4 + 6. headers and signature
        const reqId = typeof req.reqId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(req.reqId) ? req.reqId : randomUUID();
        const ts = Math.floor((this.opts.now?.() ?? Date.now()) / 1000);
        const signature: Record<string, string> = {
            'x-vh-install': installId,
            'x-vh-request-id': reqId,
            'x-vh-timestamp': String(ts),
            'x-vh-viewer': 'owner',
        };
        if (entry.secretKey) signature['x-vh-signature'] = signPluginRequest(entry.secretKey, ts, reqId, method, normalized.pathWithQuery, new Uint8Array(body));
        const headers = buildUpstreamHeaders(inbound, { target, pluginId: entry.id, signature });
        if (body.length > 0) headers['content-length'] = String(body.length);
        try {
            const res = await loopbackRequest(target, { method, path: normalized.pathWithQuery, headers, body, timeoutMs: this.opts.timeoutMs ?? UPSTREAM_TIMEOUT_MS });
            const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
            if (contentType.startsWith('text/event-stream')) { res.body.destroy(); release(); return jsonError(501, 'unsupported_upgrade', 'server-sent events are not forwarded in v1'); }
            // 5. never follow redirects — 3xx goes back as is (Location rewritten).
            const outHeaders = filterResponseHeaders(res.headers, target);
            const first = await readChunk(res.body, CHUNK_MAX, this.opts.timeoutMs ?? UPSTREAM_TIMEOUT_MS);
            if (first.end) { release(); return { status: res.status, headers: outHeaders, bodyB64: first.chunk.toString('base64') }; }
            const streamId = randomUUID();
            const stream: ResponseStream = { installId, body: res.body, nextSeq: 1, total: first.chunk.length, timer: setTimeout(() => this.closeStream(streamId), STREAM_IDLE_MS), release };
            stream.timer.unref?.();
            this.streams.set(streamId, stream);
            return { status: res.status, headers: outHeaders, bodyB64: first.chunk.toString('base64'), streamId };
        } catch (error) {
            release();
            const code = (error as NodeJS.ErrnoException)?.code;
            if (code === 'UPSTREAM_TIMEOUT') return jsonError(504, 'upstream_timeout', 'the plugin did not answer in time');
            return jsonError(502, 'upstream_unreachable', 'the plugin is not reachable on its declared port');
        }
    }

    /** `plugin-http-pull { streamId, seq }` → next ≤512KB chunk. */
    async pull(params: { installId?: string; streamId?: string; seq?: number }): Promise<{ chunkB64: string; seq: number; end: boolean } | { error: string }> {
        const stream = typeof params.streamId === 'string' ? this.streams.get(params.streamId) : undefined;
        if (!stream || (params.installId !== undefined && params.installId !== stream.installId)) return { error: 'not_found' };
        if (params.seq !== stream.nextSeq) return { error: 'invalid_request' };
        // Disabled or revoked mid-stream: stop at once.
        const entry = this.registry.byInstallId(stream.installId);
        if (!entry || checkAccess(entry, { allOf: ['panel'] })) { this.closeStream(params.streamId!); return { error: 'plugin_disabled' }; }
        clearTimeout(stream.timer);
        try {
            const { chunk, end } = await readChunk(stream.body, CHUNK_MAX, 10_000);
            stream.total += chunk.length;
            if (stream.total > RESPONSE_BODY_MAX) { this.closeStream(params.streamId!); return { error: 'payload_too_large' }; }
            const seq = stream.nextSeq++;
            if (end) this.closeStream(params.streamId!);
            else { stream.timer = setTimeout(() => this.closeStream(params.streamId!), STREAM_IDLE_MS); stream.timer.unref?.(); }
            return { chunkB64: chunk.toString('base64'), seq, end };
        } catch {
            this.closeStream(params.streamId!);
            return { error: 'upstream_timeout' };
        }
    }

    closeStream(streamId: string): void {
        const stream = this.streams.get(streamId);
        if (!stream) return;
        clearTimeout(stream.timer);
        this.streams.delete(streamId);
        stream.body.destroy();
        stream.release();
    }

    /** A disabled/removed install: drop its open streams and uploads. */
    closeInstall(installId: string): void {
        for (const [id, s] of this.streams) if (s.installId === installId) this.closeStream(id);
        for (const [id, u] of this.uploads) if (u.installId === installId) { clearTimeout(u.timer); this.uploads.delete(id); }
    }

    inFlightCount(installId: string): number { return this.inFlight.get(installId) ?? 0; }

    shutdown(): void {
        for (const id of [...this.streams.keys()]) this.closeStream(id);
        for (const u of this.uploads.values()) clearTimeout(u.timer);
        this.uploads.clear();
    }
}
