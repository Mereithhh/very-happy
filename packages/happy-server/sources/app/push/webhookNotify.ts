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
 *   - literal loopback / private / link-local / CGNAT hosts are rejected
 *     (localhost, 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10,
 *     ::1, fc00::/7, fe80::/10, v4-mapped forms, bare-number IP encodings);
 *   - redirects are refused (`redirect: 'error'`), so a public host can't
 *     bounce us to an internal one.
 *   DNS-resolution checks (hostname that resolves to an internal IP, DNS
 *   rebinding) are deliberately out of scope — documented tradeoff for a
 *   zero-dependency server.
 *
 * Delivery is best-effort: 5s timeout, no retry, failures only logged. A
 * webhook must never affect the main request path.
 */

import { log } from '@/utils/log';

export const WEBHOOK_TOKEN_PREFIX = 'webhook:';
export const WEBHOOK_URL_MAX_LENGTH = 2048;
export const WEBHOOK_TIMEOUT_MS = 5000;

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
    return false;
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

//
// Delivery
//

export interface WebhookSendResult {
    ok: boolean;
    status?: number;
    error?: string;
}

/**
 * POST the payload to the webhook URL. Best-effort: 5s timeout, no retry,
 * refuses redirects, never throws. URL is re-validated at send time so a
 * token smuggled in via the raw push-token API still can't reach a
 * forbidden host.
 */
export async function sendWebhook(url: string, payload: WebhookPayload): Promise<WebhookSendResult> {
    const invalid = validateWebhookUrl(url);
    if (invalid) {
        return { ok: false, error: `invalid url: ${invalid}` };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            redirect: 'error',
            // Cast: expo-server-sdk pulls in node-fetch v2 types whose global
            // AbortSignal shadows the built-in fetch's — runtime is fine.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            signal: controller.signal as any,
        });
        // Drain/discard the body so the connection can be reused.
        try { await res.arrayBuffer(); } catch { /* ignore */ }
        return { ok: res.ok, status: res.status };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
        clearTimeout(timer);
    }
}

/** Log helper kept here so pushDispatch stays terse. */
export function logWebhookResult(userId: string, sessionId: string, res: WebhookSendResult): void {
    if (res.ok) {
        log({ module: 'push' }, `Webhook sent for user ${userId} session ${sessionId}: status=${res.status}`);
    } else {
        log({ module: 'push', level: 'warn' }, `Webhook failed for user ${userId} session ${sessionId}: status=${res.status ?? '-'} error=${res.error ?? '-'}`);
    }
}
