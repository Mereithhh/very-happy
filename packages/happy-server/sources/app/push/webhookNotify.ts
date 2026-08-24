/**
 * Account-configured webhook notifications.
 *
 * Each account can register ONE webhook URL; when a session event push fires
 * (turn done / permission request / clarifying question) the server POSTs a
 * generic `{"title","message"}` JSON to that URL. Designed for notify-gateway
 * style receivers (e.g. an ingest URL like
 * `https://ntfy.example.com/api/ingest/<token>` that forwards to a group
 * chat), but any HTTPS endpoint accepting that JSON works.
 *
 * Storage reuses AccountPushToken (same zero-migration trick as `webpush:`):
 * the config is stored in the `token` column as
 * `webhook:{"url":"...","events":["completed","permission"]}`. The bind-mount
 * deployment can't regenerate the Prisma client, so no new tables/columns.
 *
 * Security — this is a server-side outbound request (SSRF surface):
 *   - https only, URL length capped, no userinfo in the URL;
 *   - every resolved A/AAAA address must be public unicast;
 *   - the HTTPS socket is pinned to one validated address while the original
 *     hostname remains the Host header and TLS SNI name;
 *   - redirects are not followed, responses are capped, and resolution or
 *     validation failures fail closed.
 *
 * Delivery is best-effort: 5s timeout, no retry, failures only logged. A
 * webhook must never affect the main request path.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { log } from '@/utils/log';

export const WEBHOOK_TOKEN_PREFIX = 'webhook:';
export const WEBHOOK_URL_MAX_LENGTH = 2048;
export const WEBHOOK_TIMEOUT_MS = 5000;
export const WEBHOOK_RESPONSE_MAX_BYTES = 64 * 1024;

/** Webhook event categories users can subscribe to. */
export const WEBHOOK_EVENTS = ['completed', 'permission'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface WebhookConfig {
    url: string;
    events: WebhookEvent[];
}

export interface WebhookPayload {
    title: string;
    message: string;
    /**
     * Session id, duplicated as a top-level field for receivers that parse
     * JSON. Generic gateways (e.g. apodex-bot generic) only read
     * title/message and will DROP this field — that is why the id is also
     * embedded in the message text as a fixed, parseable last line
     * (`session: <id>`), which survives any text-only relay.
     */
    sessionId?: string;
}

//
// URL validation (SSRF guard)
//

function isForbiddenIpv4(host: string): boolean {
    const parts = host.split('.').map(p => Number(p));
    if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) {
        // Not a clean dotted-quad — handled elsewhere; treat as forbidden here
        // because this function is only called on dotted-quad-looking hosts.
        return true;
    }
    const [a, b] = parts;
    if (a === 0) return true;                          // 0.0.0.0/8
    if (a === 127) return true;                        // loopback
    if (a === 10) return true;                         // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true;  // RFC1918
    if (a === 192 && b === 168) return true;           // RFC1918
    if (a === 169 && b === 254) return true;           // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (also tailnets)
    if (a === 192 && b === 0 && parts[2] === 0) return true; // IETF protocol assignments
    if (a === 192 && b === 0 && parts[2] === 2) return true; // documentation
    if (a === 192 && b === 88 && parts[2] === 99) return true; // deprecated 6to4 relay
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmark networks
    if (a === 198 && b === 51 && parts[2] === 100) return true; // documentation
    if (a === 203 && b === 0 && parts[2] === 113) return true; // documentation
    if (a >= 224) return true;                         // multicast / reserved
    return false;
}

function parseIpv6(address: string): bigint | null {
    const zoneIndex = address.indexOf('%');
    const raw = (zoneIndex === -1 ? address : address.slice(0, zoneIndex)).toLowerCase();
    const halves = raw.split('::');
    if (halves.length > 2) return null;

    const parseHalf = (half: string): number[] | null => {
        if (!half) return [];
        const words: number[] = [];
        for (const part of half.split(':')) {
            if (part.includes('.')) {
                const octets = part.split('.').map(Number);
                if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
                words.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
            } else {
                if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
                words.push(parseInt(part, 16));
            }
        }
        return words;
    };

    const left = parseHalf(halves[0]);
    const right = parseHalf(halves[1] ?? '');
    if (!left || !right) return null;
    const missing = 8 - left.length - right.length;
    if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
    const words = [...left, ...Array(missing).fill(0), ...right];
    if (words.length !== 8) return null;
    return words.reduce((value, word) => (value << 16n) | BigInt(word), 0n);
}

function inIpv6Prefix(value: bigint, prefix: bigint, bits: number): boolean {
    return (value >> BigInt(128 - bits)) === (prefix >> BigInt(128 - bits));
}

/** True only for routable public-unicast addresses accepted for egress. */
export function isPublicWebhookAddress(address: string): boolean {
    const family = isIP(address);
    if (family === 4) return !isForbiddenIpv4(address);
    if (family !== 6) return false;

    const value = parseIpv6(address);
    if (value === null) return false;
    // Accept the global-unicast allocation only, then remove special-purpose
    // subranges that must not be webhook destinations.
    if (!inIpv6Prefix(value, 0x20000000000000000000000000000000n, 3)) return false;
    if (inIpv6Prefix(value, 0x20010000000000000000000000000000n, 23)) return false; // IETF special-use
    if (inIpv6Prefix(value, 0x20010db8000000000000000000000000n, 32)) return false; // documentation
    if (inIpv6Prefix(value, 0x20020000000000000000000000000000n, 16)) return false; // 6to4
    return true;
}

function isForbiddenHost(hostname: string): boolean {
    let host = hostname.toLowerCase();
    if (host.endsWith('.')) host = host.slice(0, -1);
    // IPv6 literals come bracketed from URL.hostname.
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

    if (host.length === 0) return true;
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host.endsWith('.local') || host.endsWith('.internal')) return true;

    if (host.includes(':')) {
        // IPv6. Reject unspecified/loopback, unique-local, link-local, and
        // check the embedded address of v4-mapped forms.
        if (host === '::' || host === '::1') return true;
        if (/^f[cd]/.test(host)) return true;          // fc00::/7
        if (/^fe[89ab]/.test(host)) return true;       // fe80::/10
        // v4-mapped: WHATWG URL normalizes `::ffff:192.168.1.1` to the hex
        // form `::ffff:c0a8:101` — handle both spellings.
        const mappedDotted = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mappedDotted) return isForbiddenIpv4(mappedDotted[1]);
        const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
        if (mappedHex) {
            const hi = parseInt(mappedHex[1], 16);
            const lo = parseInt(mappedHex[2], 16);
            return isForbiddenIpv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
        }
        return false;
    }

    if (/^\d+(\.\d+){3}$/.test(host)) return isForbiddenIpv4(host);

    // Bare-number / hex / octal IP encodings (2130706433, 0x7f000001,
    // 0177.0.0.1, 127.1 …): every label is numeric → not a real DNS name,
    // and we can't cheaply canonicalize it, so reject outright.
    const labels = host.split('.');
    if (labels.every(l => /^(0x[0-9a-f]+|\d+)$/.test(l))) return true;

    return false;
}

/**
 * Validate a user-supplied webhook URL. Returns an error string, or null if
 * the URL is acceptable.
 */
export function validateWebhookUrl(raw: unknown): string | null {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
        return 'URL is required';
    }
    if (raw.length > WEBHOOK_URL_MAX_LENGTH) {
        return `URL too long (max ${WEBHOOK_URL_MAX_LENGTH} characters)`;
    }
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        return 'Invalid URL';
    }
    if (url.protocol !== 'https:') {
        return 'Only https:// URLs are allowed';
    }
    if (url.username || url.password) {
        return 'Credentials in the URL are not allowed';
    }
    if (isForbiddenHost(url.hostname)) {
        return 'Host is not allowed (localhost / private / link-local addresses are blocked)';
    }
    return null;
}

//
// Token (de)serialization
//

/** Serialize a config into the `webhook:`-prefixed AccountPushToken value. */
export function buildWebhookToken(config: WebhookConfig): string {
    return WEBHOOK_TOKEN_PREFIX + JSON.stringify({ url: config.url, events: config.events });
}

/** Parse a stored `webhook:`-prefixed token into a config, or null. */
export function parseWebhookToken(token: string): WebhookConfig | null {
    if (!token.startsWith(WEBHOOK_TOKEN_PREFIX)) return null;
    try {
        const obj = JSON.parse(token.slice(WEBHOOK_TOKEN_PREFIX.length));
        if (!obj || typeof obj.url !== 'string') return null;
        if (validateWebhookUrl(obj.url) !== null) return null;
        const events: WebhookEvent[] = Array.isArray(obj.events)
            ? obj.events.filter((e: unknown): e is WebhookEvent =>
                (WEBHOOK_EVENTS as readonly string[]).includes(e as string))
            : [...WEBHOOK_EVENTS];
        return { url: obj.url, events };
    } catch {
        return null;
    }
}

//
// Event mapping & payload
//

/**
 * Map a push-event kind ('done' | 'permission' | 'question') to the webhook
 * event category the user can toggle. Unknown kinds map to null (no send).
 */
export function mapKindToWebhookEvent(kind: unknown): WebhookEvent | null {
    switch (kind) {
        case 'done':
            return 'completed';
        case 'permission':
        case 'question':
            return 'permission';
        default:
            return null;
    }
}

function truncate(s: string, max: number): string {
    return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/**
 * Base URL of the web UI, for building clickable session links in webhook
 * messages. The server does NOT reliably know its own public web origin
 * (HAPPY_INJECT_HTML_CONFIG is arbitrary JSON injected into the webapp's
 * HTML, not an authoritative origin, and it isn't plumbed into this module),
 * so this is an explicit opt-in env: set `HAPPY_WEB_URL` (e.g.
 * `https://happy.mereith.com`) on the server to get URL lines; unset, the
 * message still carries the bare `session: <id>` line. Read per-call so
 * tests can toggle it.
 */
export function webhookWebUrlBase(): string | null {
    const raw = process.env.HAPPY_WEB_URL;
    if (!raw || raw.trim().length === 0) return null;
    return raw.trim().replace(/\/+$/, '');
}

/**
 * Build the generic `{title, message}` webhook payload from the session-event
 * push we already have (title/body/data come from the CLI daemon; we do NOT
 * extend the daemon payload for this). `data.sessionTitle` is the session
 * summary or the cwd's last path segment; `data.tool` / `data.provider` are
 * present on permission events; `data.sessionId` is injected by
 * `dispatchSessionEventPush` and drives the session link / `session: <id>`
 * trailer (see `webhookWebUrlBase` for the HAPPY_WEB_URL opt-in).
 *
 * The receiving gateway renders `title` as the message heading — `message`
 * must not repeat it as a heading of its own.
 */
export function buildWebhookPayload(push: {
    body: string;
    data: Record<string, unknown>;
}): WebhookPayload | null {
    const kind = typeof push.data.kind === 'string' ? push.data.kind : '';
    if (mapKindToWebhookEvent(kind) === null) return null;

    const rawTitle = typeof push.data.sessionTitle === 'string' && push.data.sessionTitle.trim().length > 0
        ? push.data.sessionTitle.trim()
        : (push.body || 'Session');
    const shortTitle = truncate(rawTitle, 60);
    const tool = typeof push.data.tool === 'string' ? push.data.tool : null;
    const provider = typeof push.data.provider === 'string' ? push.data.provider : null;

    let title: string;
    let headline: string;
    switch (kind) {
        case 'done':
            title = `✅ 任务完成 · ${shortTitle}`;
            headline = '任务已完成，会话空闲，等待下一步指令。';
            break;
        case 'permission':
            title = `⏸ 需要确认 · ${shortTitle}`;
            headline = tool ? `请求执行工具：${tool}，等待确认。` : '有权限请求等待确认。';
            break;
        case 'question':
        default:
            title = `❓ 等待回答 · ${shortTitle}`;
            headline = 'Agent 提出了问题，等待回答。';
            break;
    }

    const sessionId = typeof push.data.sessionId === 'string' && push.data.sessionId.trim().length > 0
        ? push.data.sessionId.trim()
        : null;

    const lines = [headline, `会话：${truncate(rawTitle, 200)}`];
    if (provider) lines.push(`Agent：${provider}`);
    if (sessionId) {
        const base = webhookWebUrlBase();
        if (base) lines.push(`链接：${base}/session/${sessionId}`);
        // Fixed, machine-parseable LAST line. External automation (e.g. the
        // Tanka quote-reply dispatcher) extracts the id from here — keep the
        // exact `session: <id>` format stable.
        lines.push(`session: ${sessionId}`);
    }
    const payload: WebhookPayload = { title, message: lines.join('\n') };
    if (sessionId) payload.sessionId = sessionId;
    return payload;
}

/**
 * Build the payload for a MANUAL notification (web-initiated, e.g. the user
 * clicking "mark done" on the task board) — as opposed to the daemon-driven
 * session events above. The caller supplies title/message; this function
 * appends the same structured trailer lines the event payload carries:
 * an optional clickable link (HAPPY_WEB_URL opt-in) and the stable,
 * machine-parseable `session: <id>` LAST line (docs/channels.md contract —
 * quote-reply adapters route on it). Task-scoped notifications get a
 * `task: <id>` line; it sits BEFORE the session line so the session trailer
 * stays last.
 *
 * `link` is a web-app PATH (must start with '/', e.g. `/terminal/<machineId>
 * ?tid=<terminalId>` from the daemon's web-terminal notifications): it is
 * appended as a clickable `链接：<base><path>` line right after the message —
 * only when HAPPY_WEB_URL is configured (same opt-in as the session link).
 */
export function buildManualWebhookPayload(input: {
    title: string;
    message?: string;
    sessionId?: string;
    taskId?: string;
    link?: string;
}): WebhookPayload {
    const title = truncate(input.title.trim(), 200);
    const lines: string[] = [];
    const message = input.message?.trim();
    if (message) lines.push(truncate(message, 1000));

    const link = input.link?.trim() || null;
    if (link && link.startsWith('/')) {
        const base = webhookWebUrlBase();
        if (base) lines.push(`链接：${base}${link}`);
    }

    const sessionId = input.sessionId?.trim() || null;
    const taskId = input.taskId?.trim() || null;
    if (sessionId) {
        const base = webhookWebUrlBase();
        if (base) lines.push(`链接：${base}/session/${sessionId}`);
    }
    if (taskId) lines.push(`task: ${taskId}`);
    if (sessionId) lines.push(`session: ${sessionId}`);

    const payload: WebhookPayload = { title, message: lines.join('\n') };
    if (sessionId) payload.sessionId = sessionId;
    return payload;
}

//
// Per-account rate limiting (in-memory, zero-dependency — same school as the
// IP limiters in accountAuthRoutes/unlockRoutes, but keyed by account and
// extracted here so it is unit-testable).
//

export interface AccountRateLimiter {
    /** true = allowed (and counted); false = over the limit right now */
    allow(accountId: string, now?: number): boolean;
}

export function createAccountRateLimiter(opts: { max: number; windowMs: number }): AccountRateLimiter {
    const hits = new Map<string, number[]>();
    return {
        allow(accountId: string, now: number = Date.now()): boolean {
            const cutoff = now - opts.windowMs;
            const list = (hits.get(accountId) ?? []).filter(t => t > cutoff);
            if (list.length >= opts.max) {
                hits.set(accountId, list);
                return false;
            }
            list.push(now);
            hits.set(accountId, list);
            // Opportunistic cleanup so idle accounts don't accumulate forever.
            if (hits.size > 10_000) {
                for (const [k, v] of hits) {
                    if (v.every(t => t <= cutoff)) hits.delete(k);
                }
            }
            return true;
        }
    };
}

//
// Delivery
//

export interface WebhookSendResult {
    ok: boolean;
    status?: number;
    error?: string;
}

export interface WebhookAddress {
    address: string;
    family: 4 | 6;
}

export interface WebhookDeliveryTarget extends WebhookAddress {
    url: URL;
    /** Original DNS name retained for Host and certificate verification/SNI. */
    hostname: string;
}

export type WebhookResolver = (hostname: string) => Promise<WebhookAddress[]>;
export type WebhookTransport = (
    target: WebhookDeliveryTarget,
    body: string,
) => Promise<WebhookSendResult>;

async function resolveWithSystemDns(hostname: string): Promise<WebhookAddress[]> {
    const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
    return addresses
        .filter((entry): entry is { address: string; family: 4 | 6 } => entry.family === 4 || entry.family === 6)
        .map(entry => ({ address: entry.address, family: entry.family }));
}

/** Resolve and validate all answers before selecting the address to pin. */
export async function resolveWebhookTarget(rawUrl: string, resolve: WebhookResolver): Promise<WebhookDeliveryTarget> {
    const url = new URL(rawUrl);
    const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
        ? url.hostname.slice(1, -1)
        : url.hostname;
    const addresses = await resolve(hostname);
    if (addresses.length === 0) throw new Error('webhook host did not resolve');
    if (addresses.some(entry => isIP(entry.address) !== entry.family || !isPublicWebhookAddress(entry.address))) {
        throw new Error('webhook host resolved to a non-public address');
    }
    return { url, hostname, ...addresses[0] };
}

/** HTTPS transport whose lookup callback can return only the validated IP. */
export async function sendPinnedHttps(target: WebhookDeliveryTarget, body: string): Promise<WebhookSendResult> {
    return new Promise((resolve, reject) => {
        const request = httpsRequest(target.url, {
            method: 'POST',
            // A pooled socket could have been opened from an earlier DNS
            // answer. Force a fresh connection so this delivery's validated
            // address is the one that is actually dialed.
            agent: false,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                Host: target.url.host,
            },
            servername: isIP(target.hostname) === 0 ? target.hostname : undefined,
            lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
        }, response => {
            let responseBytes = 0;
            response.on('data', (chunk: Buffer | string) => {
                responseBytes += Buffer.byteLength(chunk);
                if (responseBytes > WEBHOOK_RESPONSE_MAX_BYTES) {
                    request.destroy(new Error('webhook response too large'));
                }
            });
            response.on('end', () => {
                const status = response.statusCode ?? 0;
                // 3xx is deliberately an ordinary failed result: this client
                // never follows Location and therefore never re-resolves it.
                resolve({ ok: status >= 200 && status < 300, status });
            });
        });
        request.setTimeout(WEBHOOK_TIMEOUT_MS, () => request.destroy(new Error('webhook request timed out')));
        request.on('error', reject);
        request.end(body);
    });
}

export async function sendWebhookWithDependencies(
    url: string,
    payload: WebhookPayload,
    dependencies: { resolve: WebhookResolver; transport: WebhookTransport },
): Promise<WebhookSendResult> {
    const invalid = validateWebhookUrl(url);
    if (invalid) return { ok: false, error: `invalid url: ${invalid}` };
    let resolutionTimer: ReturnType<typeof setTimeout> | undefined;
    try {
        const target = await Promise.race([
            resolveWebhookTarget(url, dependencies.resolve),
            new Promise<never>((_resolve, reject) => {
                resolutionTimer = setTimeout(() => reject(new Error('webhook DNS resolution timed out')), WEBHOOK_TIMEOUT_MS);
            }),
        ]);
        return await dependencies.transport(target, JSON.stringify(payload));
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
        if (resolutionTimer) clearTimeout(resolutionTimer);
    }
}

/**
 * POST the payload to the webhook URL. Best-effort: 5s timeout, no retry,
 * refuses redirects, never throws. URL is re-validated at send time so a
 * token smuggled in via the raw push-token API still can't reach a
 * forbidden host.
 */
export async function sendWebhook(url: string, payload: WebhookPayload): Promise<WebhookSendResult> {
    return sendWebhookWithDependencies(url, payload, {
        resolve: resolveWithSystemDns,
        transport: sendPinnedHttps,
    });
}

/** Log helper kept here so pushDispatch stays terse. */
export function logWebhookResult(userId: string, sessionId: string, res: WebhookSendResult): void {
    if (res.ok) {
        log({ module: 'push', userId, sessionId, status: res.status }, 'Webhook sent');
    } else {
        log({ module: 'push', level: 'warn', userId, sessionId, status: res.status, failed: true }, 'Webhook failed');
    }
}
