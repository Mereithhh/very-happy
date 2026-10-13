/**
 * Web Push hygiene (B-569) — PURE helpers, no db / network (pushHygiene.spec.ts).
 *
 *  - `webPushTopic`: RFC 8030 §5.4 `Topic` header. The push service keeps only
 *    the NEWEST pending message per (subscription, topic), so a device that was
 *    offline overnight receives at most one push per session instead of a
 *    backlog. The header must be ≤32 chars of the URL-safe base64 alphabet; we
 *    hash the target key so raw session ids never reach the push service and
 *    id length/charset never matter.
 *  - `webPushTtlSeconds`: how long the push service may hold an undelivered
 *    message. Decision-needed (permission/question) 24h — the agent stays
 *    blocked, still worth seeing tomorrow morning; completion (done/completed)
 *    6h — after that it is noise, the in-app notification center still has it;
 *    test 5min. Unknown kinds take the longer, safe value.
 *  - `selectSeenWatermark`: the subset of the account's cross-device read
 *    watermark (`vh.notif-seen.v1`, `{ seen: { <key>: ms } }`) that fits in the
 *    push payload. The service worker uses it to close notifications the user
 *    already read on another device (see public/push-sw.js).
 *
 * Key space (shared with web `targetKeyOfPath` and the SW): a session id,
 * `t:<terminalId>` for terminals, or `test`.
 */

import crypto from 'node:crypto';

export const WEB_PUSH_TOPIC_MAX = 32;

export const TTL_DECISION_S = 24 * 60 * 60;
export const TTL_COMPLETION_S = 6 * 60 * 60;
export const TTL_TEST_S = 5 * 60;
/** Default when the caller passes no TTL (was 28 days before B-569). */
export const TTL_DEFAULT_S = TTL_DECISION_S;

export function webPushTopic(key: string): string {
    return crypto.createHash('sha256').update(`vh:${key}`).digest('base64url').slice(0, WEB_PUSH_TOPIC_MAX);
}

export function webPushTtlSeconds(kind: unknown): number {
    switch (kind) {
        case 'done':
        case 'completed':
            return TTL_COMPLETION_S;
        case 'test':
            return TTL_TEST_S;
        case 'permission':
        case 'question':
        default:
            return TTL_DECISION_S;
    }
}

/**
 * Target key of a push, mirroring the SW's `vhPushKey`: sessionId first,
 * otherwise derived from the app path in `data.url`.
 */
export function pushTargetKey(data: Record<string, unknown>): string | null {
    if (data.kind === 'test') return 'test';
    if (typeof data.sessionId === 'string' && data.sessionId.length > 0) return data.sessionId;
    const url = typeof data.url === 'string' ? data.url : '';
    if (!url.startsWith('/')) return null;
    const [path, query = ''] = url.split('?');
    const parts = path.split('/').filter(Boolean);
    if (parts.length !== 2) return null;
    if (parts[0] === 'session') return parts[1].startsWith('pending-') ? null : parts[1];
    if (parts[0] === 'terminal') {
        const tid = new URLSearchParams(query).get('tid');
        return tid ? `t:${tid}` : null;
    }
    return null;
}

export type SeenMap = Record<string, number>;

/** Tolerant decode of the raw KV bytes (`{"seen":{...}}`); junk → {}. */
export function parseSeenKvValue(raw: Uint8Array | null | undefined): SeenMap {
    if (!raw || raw.length === 0) return {};
    let obj: unknown;
    try {
        obj = JSON.parse(Buffer.from(raw).toString('utf8'));
    } catch {
        return {};
    }
    const src = obj && typeof obj === 'object' ? (obj as { seen?: unknown }).seen : null;
    if (!src || typeof src !== 'object' || Array.isArray(src)) return {};
    const out: SeenMap = {};
    for (const [key, value] of Object.entries(src as Record<string, unknown>)) {
        if (!key || typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
        out[key] = value;
    }
    return out;
}

/** Plaintext budget for the whole payload. Web Push's single aes128gcm record
 * caps plaintext at ~3993 bytes; keep a margin. */
export const PUSH_PAYLOAD_BUDGET_BYTES = 3500;
export const SEEN_WATERMARK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const SEEN_WATERMARK_MAX_ENTRIES = 40;

/**
 * Newest-first subset of `seen` (last 7 days, ≤40 keys) whose JSON fits in
 * `budgetBytes`. Returns null when nothing fits / nothing qualifies, so the
 * caller omits the field entirely (old-server-equivalent payload).
 */
export function selectSeenWatermark(
    seen: SeenMap,
    now: number,
    budgetBytes: number,
    maxEntries: number = SEEN_WATERMARK_MAX_ENTRIES,
    maxAgeMs: number = SEEN_WATERMARK_MAX_AGE_MS,
): SeenMap | null {
    // `"seen":{}` plus the separating comma.
    let used = Buffer.byteLength(',"seen":{}');
    if (budgetBytes < used) return null;
    const horizon = now - maxAgeMs;
    const entries = Object.entries(seen)
        .filter(([, at]) => at > horizon)
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const out: SeenMap = {};
    let count = 0;
    for (const [key, at] of entries) {
        if (count >= maxEntries) break;
        const cost = Buffer.byteLength(JSON.stringify(key)) + 1 + String(at).length + (count > 0 ? 1 : 0);
        if (used + cost > budgetBytes) break;
        out[key] = at;
        used += cost;
        count++;
    }
    return count > 0 ? out : null;
}

/**
 * Attach `sentAt` + (budget permitting) `seen` to a base `{title, body, data}`
 * payload. Pure: `seen` is the already-loaded account watermark (or null).
 */
export function buildWebPushPayload(
    base: { title: string; body: string; data: Record<string, unknown> },
    seen: SeenMap | null,
    now: number,
): Record<string, unknown> {
    const payload: Record<string, unknown> = { ...base, sentAt: now };
    if (seen) {
        const remaining = PUSH_PAYLOAD_BUDGET_BYTES - Buffer.byteLength(JSON.stringify(payload));
        const picked = selectSeenWatermark(seen, now, remaining);
        if (picked) payload.seen = picked;
    }
    return payload;
}
