import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Server } from 'socket.io';
import { db } from '@/storage/db';
import { log } from '@/utils/log';
import { routeRpcToRoom, rpcRoom } from '@/app/api/socket/rpcHandler';
import { loadAccountSecret } from '@/app/auth/accountSecrets';
import { contentKeyPairFromSecret, decodeAccountSecret, decryptWithDataKey, encryptWithDataKey, unwrapDataEncryptionKey } from '@/app/session/sessionCrypto';
import { pluginFrameAncestors, pluginHostConfig, pluginLabelOfHost, pluginOrigin, pluginsEnabledFor, type PluginHostConfig } from './pluginConfig';
import {
    claimTicketNonce, FRAME_COOKIE, frameCookie, frameSessionFor, loginSessionAlive, readCookie, safeEntryPath, sameSite, shouldRenew,
    verifyToken, type FramePayload, type TicketPayload,
} from './pluginFrame';
import { forwardRequestHeaders, hostResponseHeaders, isServiceWorkerRequest, isUnsupportedUpgrade, originAllowed, rewriteResponseHeaders, type HeaderMap } from './pluginHeaders';
import { hasGrant, installBlock, type InstallRow } from './pluginRules';
import { normalizePluginRequestPath, type PluginManifest } from '@slopus/happy-wire';

/**
 * B-974 §4.2–§4.6: requests whose `Host` is `<label>.<VH_PLUGIN_HOST>`. Handled before anything else in
 * the HTTP server (no API route, static file, CORS or HTML hook ever sees them):
 *
 *   /__vh/health           200
 *   /__vh/enter?t=<ticket> one-time ticket → `__Host-vhp` frame session → 302 to the panel path
 *   /__vh/*                404 (reserved, never forwarded)
 *   anything else          frame session + Origin check → machine RPC `plugin-http` → daemon → upstream
 *
 * The browser never names the target: the daemon takes the upstream from the approved manifest by panel.
 */

export const INLINE_BODY_MAX = 256 * 1024;
export const BODY_CHUNK_MAX = 512 * 1024;
export const REQUEST_BODY_MAX = 8 * 1024 * 1024;
export const RESPONSE_BODY_MAX = 32 * 1024 * 1024;
const TOTAL_TIMEOUT_MS = 30_000;
const CHUNK_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT_PER_INSTALL = 16;

const inflight = new Map<string, number>();
let ioRef: Server | null = null;
export function setPluginGatewayIo(io: Server | null): void { ioRef = io; }

/** Seam for tests: how the gateway reaches the daemon. */
export type PluginRpc = (accountId: string, machineId: string, method: 'plugin-http' | 'plugin-http-body' | 'plugin-http-pull', params: unknown, timeoutMs: number) => Promise<unknown>;

let rpcImpl: PluginRpc = defaultRpc;
export function setPluginRpcForTests(impl: PluginRpc | null): void { rpcImpl = impl ?? defaultRpc; }

const machineKeyCache = new Map<string, { key: Uint8Array; at: number }>();
async function machineKey(accountId: string, machineId: string): Promise<Uint8Array | null> {
    const cacheKey = `${accountId}:${machineId}`;
    const cached = machineKeyCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.key;
    const machine = await db.machine.findFirst({ where: { id: machineId, accountId }, select: { dataEncryptionKey: true } });
    if (!machine?.dataEncryptionKey) return null;
    const credential = await db.accountCredential.findUnique({ where: { accountId }, select: { secretEnc: true } });
    const secret = await loadAccountSecret(db, accountId, credential?.secretEnc);
    if (!secret) return null;
    let key: Uint8Array | null = null;
    try { key = unwrapDataEncryptionKey(new Uint8Array(machine.dataEncryptionKey), contentKeyPairFromSecret(decodeAccountSecret(secret))); } catch { key = null; }
    if (key) machineKeyCache.set(cacheKey, { key, at: Date.now() });
    return key;
}

class GatewayError extends Error {
    constructor(public status: number, public code: string) { super(code); }
}

async function defaultRpc(accountId: string, machineId: string, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!ioRef) throw new GatewayError(502, 'upstream_unreachable');
    const key = await machineKey(accountId, machineId);
    if (!key) throw new GatewayError(502, 'machine_unsupported');
    const full = `${machineId}:${method}`;
    const sealed = Buffer.from(encryptWithDataKey(params, key)).toString('base64');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const routed = await Promise.race([
        routeRpcToRoom(ioRef, rpcRoom(accountId, full), full, sealed),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new GatewayError(504, 'upstream_timeout')), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
    if (!routed.ok) throw new GatewayError(routed.code === 'timeout' ? 504 : 502, routed.code === 'timeout' ? 'upstream_timeout' : 'upstream_unreachable');
    const raw = routed.result;
    if (typeof raw !== 'string') throw new GatewayError(502, 'upstream_unreachable');
    const opened = decryptWithDataKey(new Uint8Array(Buffer.from(raw, 'base64')), key);
    if (!opened || typeof opened !== 'object') throw new GatewayError(502, 'upstream_unreachable');
    return opened;
}

function sendError(res: ServerResponse, status: number, code: string, frameAncestors: readonly string[] = []) {
    if (res.headersSent) { res.destroy(); return; }
    const body = JSON.stringify({ error: code });
    res.writeHead(status, { ...hostResponseHeaders(frameAncestors), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
    res.end(body);
}

function redirect(res: ServerResponse, location: string, headers: Record<string, string>) {
    res.writeHead(302, { ...headers, location, 'cache-control': 'no-store', 'content-length': 0 });
    res.end();
}

/**
 * WebSocket `Upgrade` on a plugin origin (§4.6: not forwarded). Node never runs the request hooks for these, so
 * without this the socket is just dropped (curl: empty reply). Answers `501 unsupported_upgrade` and closes.
 * The URL is moved off every real path first, so no later `upgrade` listener (Socket.IO) can take the socket.
 * Returns true when the request was for a plugin origin.
 */
export function handlePluginHostUpgrade(req: IncomingMessage, socket: Duplex, config: PluginHostConfig | null = pluginHostConfig()): boolean {
    if (!pluginLabelOfHost(req.headers.host, config)) return false;
    req.url = '/__vh/unsupported-upgrade';
    const body = JSON.stringify({ error: 'unsupported_upgrade' });
    const headers: Record<string, string | number> = { ...hostResponseHeaders([]), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body), connection: 'close' };
    socket.on('error', () => undefined);
    socket.end(`HTTP/1.1 501 Not Implemented\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${body}`);
    return true;
}

/** True when the request was a plugin-origin request (and has been answered). */
export function handlePluginHostRequest(req: IncomingMessage, res: ServerResponse, config: PluginHostConfig | null = pluginHostConfig()): boolean {
    const label = pluginLabelOfHost(req.headers.host, config);
    if (!label || !config) return false;
    void serve(req, res, label, config).catch(error => {
        log({ module: 'plugins', level: 'warn', error }, 'plugin gateway failed');
        sendError(res, error instanceof GatewayError ? error.status : 502, error instanceof GatewayError ? error.code : 'upstream_unreachable');
    });
    return true;
}

async function serve(req: IncomingMessage, res: ServerResponse, label: string, config: PluginHostConfig) {
    const url = new URL(req.url ?? '/', 'http://plugin.invalid');
    if (url.pathname === '/__vh/health') {
        res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
        res.end('ok');
        return;
    }
    const install = await db.pluginInstall.findUnique({ where: { originLabel: label } }) as InstallRow | null;
    const origin = pluginOrigin(label, config);
    if (!install || !pluginsEnabledFor(install.accountId)) return sendError(res, 404, 'not_found');
    if (url.pathname === '/__vh/enter') return enter(req, res, url, install, origin, config);
    if (url.pathname.startsWith('/__vh/')) return sendError(res, 404, 'not_found');

    const cookie = readCookie(req.headers.cookie, FRAME_COOKIE);
    const frame = verifyToken<FramePayload>('frame', cookie);
    const ancestors = pluginFrameAncestors(frame?.o ?? null);
    if (!frame || frame.i !== install.id || frame.a !== install.accountId || frame.e !== install.frameEpoch) return sendError(res, 401, 'frame_session_required', ancestors);
    if (installBlock(install) || !hasGrant(install, 'panel')) return sendError(res, 403, 'plugin_disabled', ancestors);
    if (!await loginSessionAlive(frame.l, install.accountId)) return sendError(res, 401, 'frame_session_required', ancestors);
    if (isServiceWorkerRequest(req.headers)) return sendError(res, 404, 'not_found', ancestors);
    if (isUnsupportedUpgrade(req.headers)) return sendError(res, 501, 'unsupported_upgrade', ancestors);
    if (!originAllowed(req.method ?? 'GET', req.headers, origin)) return sendError(res, 403, 'origin_mismatch', ancestors);
    // §4.6 step 3, also enforced by the daemon: `..` segments, backslashes, NUL / control bytes (raw or encoded) never leave the server.
    if (normalizePluginRequestPath(req.url ?? '/') === null) return sendError(res, 400, 'invalid_path', ancestors);

    const running = inflight.get(install.id) ?? 0;
    if (running >= MAX_CONCURRENT_PER_INSTALL) return sendError(res, 429, 'rate_limited', ancestors);
    inflight.set(install.id, running + 1);
    try {
        const renew = shouldRenew(frame) ? frameSessionFor(install, frame.p, frame.l, frame.o) : null;
        await forward(req, res, url, install, frame.p, ancestors, renew ? frameCookie(renew.token, !sameSite(frame.o, config.host)) : null);
    } finally {
        const left = (inflight.get(install.id) ?? 1) - 1;
        if (left <= 0) inflight.delete(install.id); else inflight.set(install.id, left);
    }
}

async function enter(req: IncomingMessage, res: ServerResponse, url: URL, install: InstallRow, origin: string, config: PluginHostConfig) {
    if (req.method !== 'GET') return sendError(res, 405, 'method_not_allowed');
    const ticket = verifyToken<TicketPayload>('ticket', url.searchParams.get('t') ?? undefined);
    const ancestors = pluginFrameAncestors(ticket?.o ?? null);
    if (!ticket || ticket.i !== install.id || ticket.a !== install.accountId) return sendError(res, 401, 'invalid_ticket', ancestors);
    if (installBlock(install) || !hasGrant(install, 'panel')) return sendError(res, 403, 'plugin_disabled', ancestors);
    const panel = ((install.manifest as PluginManifest | null)?.panels ?? []).find(p => p.id === ticket.p);
    if (!panel) return sendError(res, 404, 'not_found', ancestors);
    if (!await loginSessionAlive(ticket.l, install.accountId)) return sendError(res, 401, 'invalid_ticket', ancestors);
    if (!await claimTicketNonce(ticket.n, ticket.exp)) return sendError(res, 401, 'invalid_ticket', ancestors);
    const session = frameSessionFor(install, panel.id, ticket.l, ticket.o);
    void origin;
    redirect(res, safeEntryPath(url.searchParams.get('p') ?? ticket.path, panel.entry ?? '/'), {
        ...hostResponseHeaders(ancestors),
        'set-cookie': frameCookie(session.token, !sameSite(ticket.o, config.host)),
    });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > REQUEST_BODY_MAX) throw new GatewayError(413, 'payload_too_large');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > REQUEST_BODY_MAX) throw new GatewayError(413, 'payload_too_large');
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
}

interface HttpResponse { status: number; headers: HeaderMap; bodyB64?: string; streamId?: string; error?: string }
interface PullResponse { chunkB64?: string; end?: boolean; error?: string }

/** Splits a request body into the `plugin-http-body` chunks (≤ 512 KB each, the last one `end: true`). */
export function bodyChunks(body: Buffer): Buffer[] {
    const out: Buffer[] = [];
    for (let i = 0; i < body.length; i += BODY_CHUNK_MAX) out.push(body.subarray(i, i + BODY_CHUNK_MAX));
    return out;
}

async function forward(req: IncomingMessage, res: ServerResponse, url: URL, install: InstallRow, panelId: string, ancestors: readonly string[], renewCookie: string | null) {
    const deadline = Date.now() + TOTAL_TIMEOUT_MS;
    const left = () => Math.max(1, Math.min(CHUNK_TIMEOUT_MS * 3, deadline - Date.now()));
    const method = (req.method ?? 'GET').toUpperCase();
    const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
    const reqId = `req_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
    // The panel this frame session entered (signed in the cookie); the daemon takes that panel's upstream from the
    // approved manifest. Nothing from the browser chooses the target.
    if (!((install.manifest as PluginManifest | null)?.panels ?? []).some(p => p.id === panelId)) throw new GatewayError(404, 'not_found');
    let bodyStreamId: string | undefined;
    if (body.length > INLINE_BODY_MAX) {
        bodyStreamId = `${reqId}-body`;
        const chunks = bodyChunks(body);
        for (let seq = 0; seq < chunks.length; seq++) {
            await rpcImpl(install.accountId, install.machineId, 'plugin-http-body', { installId: install.id, streamId: bodyStreamId, seq, chunkB64: chunks[seq].toString('base64'), end: seq === chunks.length - 1 }, Math.min(CHUNK_TIMEOUT_MS, left()));
        }
    }
    const response = await rpcImpl(install.accountId, install.machineId, 'plugin-http', {
        reqId, installId: install.id, panelId, method, path: url.pathname, query: url.search.replace(/^\?/, ''),
        headers: forwardRequestHeaders(req.headers),
        ...(bodyStreamId ? { bodyStreamId } : body.length ? { bodyB64: body.toString('base64') } : {}),
    }, left()) as HttpResponse;
    if (response.error) throw new GatewayError(gatewayStatus(response.error), response.error);
    if (typeof response.status !== 'number' || response.status < 100 || response.status > 599) throw new GatewayError(502, 'upstream_unreachable');
    const headers = rewriteResponseHeaders(response.headers ?? {}, ancestors);
    if (renewCookie) headers['set-cookie'] = [...(Array.isArray(headers['set-cookie']) ? headers['set-cookie'] : headers['set-cookie'] ? [headers['set-cookie']] : []), renewCookie];
    const first = response.bodyB64 ? Buffer.from(response.bodyB64, 'base64') : Buffer.alloc(0);
    if (first.length > BODY_CHUNK_MAX) throw new GatewayError(502, 'upstream_unreachable');
    if (!response.streamId) {
        res.writeHead(response.status, { ...headers, 'content-length': String(first.length) });
        res.end(method === 'HEAD' ? undefined : first);
        return;
    }
    res.writeHead(response.status, headers);
    let total = first.length;
    if (first.length) res.write(first);
    for (let seq = 1; ; seq++) {
        if (Date.now() >= deadline) { res.destroy(); return; }
        const chunk = await rpcImpl(install.accountId, install.machineId, 'plugin-http-pull', { installId: install.id, streamId: response.streamId, seq }, Math.min(CHUNK_TIMEOUT_MS, left())) as PullResponse;
        if (chunk.error) { res.destroy(); return; }
        const data = chunk.chunkB64 ? Buffer.from(chunk.chunkB64, 'base64') : Buffer.alloc(0);
        total += data.length;
        if (data.length > BODY_CHUNK_MAX || total > RESPONSE_BODY_MAX) { res.destroy(); return; }
        if (data.length) res.write(data);
        if (chunk.end) break;
    }
    res.end();
}

function gatewayStatus(code: string): number {
    switch (code) {
        case 'upstream_timeout': return 504;
        case 'invalid_path': case 'invalid_request': return 400;
        case 'rate_limited': return 429;
        case 'payload_too_large': return 413;
        case 'unsupported_upgrade': return 501;
        case 'plugin_disabled': case 'permission_denied': case 'plugin_pending': case 'plugin_rejected': case 'disabled_by_operator': return 403;
        default: return 502;
    }
}
