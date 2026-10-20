/**
 * Push notification dispatch.
 *
 * Single entry point: dispatchSessionEventPush — rich session-event
 * ("It's ready!", permission, question) called by CLI/daemon clients.
 *
 * Generic per-message pushes were removed: the CLI streams every assistant
 * chunk, tool_use, and tool_result as a session message, so notifying on each
 * insert produced one buzz every 10s during a turn with no useful title.
 * Connected clients still receive the realtime message update over socket;
 * only the Expo push for "new message" went away.
 *
 * Suppression: if the user has ANY non-machine client that is active
 * (connected + not backgrounded), suppress the push — they can see in-app
 * indicators (unread dots, tab title counter) instead. Account webhooks are
 * exempt: they feed an external channel (group chat), not the device the user
 * is looking at, so they dispatch before (and regardless of) the presence
 * check.
 *
 * "Active" is determined by socket.data.appState:
 *   - Clients send `app-state: { state: 'active' | 'background' }` via socket.
 *   - Old clients that never send it are treated as active (connected = present).
 *   - On disconnect the socket (and its state) disappears automatically.
 */

import { db } from "@/storage/db";
import { isUserActive } from "@/app/push/focusTracker";
import { sendPushNotifications } from "@/app/push/pushSend";
import { parseWebPushToken, sendWebPush, webPushConfigured } from "@/app/push/webPush";
import {
    buildWebPushPayload,
    capSeenAt,
    parseSeenKvValue,
    pushTargetKey,
    webPushTopic,
    webPushTtlSeconds,
    type SeenMap,
} from "@/app/push/pushHygiene";
import {
    WEBHOOK_TOKEN_PREFIX,
    buildWebhookPayload,
    isWebhookTokenCorrupt,
    mapKindToWebhookEvent,
    parseWebhookToken,
} from "@/app/push/webhookNotify";
import { deliverAccountWebhook } from "@/app/push/webhookDelivery";
import { log } from "@/utils/log";

/**
 * Delete a dead/malformed push token. Prisma queries are LAZY — they only run
 * once awaited or `.then`-ed — so the old `void db.accountPushToken.deleteMany()`
 * never executed and dead subscriptions were retried forever. Always settle it.
 */
function pruneToken(id: string): Promise<void> {
    return db.accountPushToken.deleteMany({ where: { id } }).then(
        () => undefined,
        (error: unknown) => {
            log({ module: 'push', level: 'warn', error }, 'Push token prune failed');
        },
    );
}

async function sendExpo(
    params: { userId: string; sessionId: string; title: string; body: string; data: Record<string, unknown>; channelId: string },
    tokens: { id: string; token: string }[],
): Promise<void> {
    if (tokens.length === 0) return;

    const tickets = await sendPushNotifications(
        tokens.map(t => ({
            to: t.token,
            title: params.title,
            body: params.body,
            data: params.data,
            sound: 'default' as const,
            channelId: params.channelId
        }))
    );

    let okCount = 0;
    const errors: string[] = [];
    for (let i = 0; i < tickets.length; i++) {
        const ticket = tickets[i];
        if (ticket.status === 'ok') {
            okCount++;
            continue;
        }
        errors.push(ticket.details?.error || ticket.message || 'unknown');
        if (ticket.details?.error === 'DeviceNotRegistered') {
            void pruneToken(tokens[i].id);
        }
    }

    if (errors.length === 0) {
        log({ module: 'push', userId: params.userId, sessionId: params.sessionId, okCount }, 'Expo push sent');
    } else {
        log({
            module: 'push',
            level: 'warn',
            userId: params.userId,
            sessionId: params.sessionId,
            okCount,
            failedCount: errors.length,
        }, 'Expo push partially failed');
    }
}

/** Account KV key the web app writes its cross-device read watermark to
 * (web `sync/notificationSeenStore.ts` SEEN_KV_KEY). Read-only here. */
export const NOTIFICATION_SEEN_KV_KEY = 'vh.notif-seen.v1';

/**
 * B-569: the account's read watermark for the push payload (`seen`). One
 * unique-index lookup per dispatch; any failure → null (payload then matches
 * what an old server sends, and the SW closes nothing).
 */
async function loadSeenWatermark(userId: string): Promise<SeenMap | null> {
    try {
        const row = await db.userKVStore.findUnique({
            where: { accountId_key: { accountId: userId, key: NOTIFICATION_SEEN_KV_KEY } },
            select: { value: true, updatedAt: true },
        });
        if (!row) return null;
        // Device clocks may run fast: cap stamps at the server write time.
        const seen = capSeenAt(parseSeenKvValue(row.value), row.updatedAt.getTime());
        return Object.keys(seen).length > 0 ? seen : null;
    } catch (error) {
        log({ module: 'push', level: 'warn', error }, 'Seen watermark load failed; sending without it');
        return null;
    }
}

export interface WebPushFanoutResult {
    total: number;
    sent: number;
    failed: number;
    pruned: number;
}

async function sendWeb(
    params: { userId: string; sessionId: string; title: string; body: string; data: Record<string, unknown> },
    tokens: { id: string; token: string }[],
): Promise<WebPushFanoutResult> {
    const result: WebPushFanoutResult = { total: tokens.length, sent: 0, failed: 0, pruned: 0 };
    if (tokens.length === 0) return result;

    // B-569: per-target Topic + per-class TTL; `sentAt` + `seen` ride along in
    // the payload (old service workers ignore unknown top-level fields).
    const key = pushTargetKey(params.data);
    const opts = {
        ttlSeconds: webPushTtlSeconds(params.data.kind),
        ...(key ? { topic: webPushTopic(key) } : {}),
    };
    const seen = await loadSeenWatermark(params.userId);
    const payload = buildWebPushPayload(
        { title: params.title, body: params.body, data: params.data },
        seen,
        Date.now(),
    );

    await Promise.all(tokens.map(async (t) => {
        const sub = parseWebPushToken(t.token);
        if (!sub) {
            // Malformed stored subscription — prune it.
            result.pruned++;
            result.failed++;
            await pruneToken(t.id);
            return;
        }
        const res = await sendWebPush(sub, payload, opts);
        if (res.ok) {
            result.sent++;
        } else {
            result.failed++;
        }
        if (res.gone) {
            result.pruned++;
            await pruneToken(t.id);
        }
    }));

    log({
        module: 'push',
        userId: params.userId,
        sessionId: params.sessionId,
        okCount: result.sent,
        prunedCount: result.pruned,
        tokenCount: tokens.length,
    }, 'Web push completed');
    return result;
}

/**
 * Account webhooks: POST a generic `{title, message}` JSON to the user's own
 * endpoint (e.g. a notify-gateway ingest URL that forwards to a group chat).
 * Same trigger as the other push channels but PRESENCE-INDEPENDENT: an open
 * happy tab suppresses device pushes, never webhooks — the external channel
 * must hear about completions either way. Transient failures are retried with
 * backoff and every outcome is counted (webhookDelivery.ts, B-026); never thrown.
 */
async function sendWebhooks(
    params: { userId: string; sessionId: string; body: string; data: Record<string, unknown> },
    tokens: { id: string; token: string }[],
): Promise<void> {
    if (tokens.length === 0) return;

    const event = mapKindToWebhookEvent(params.data.kind);
    const payload = buildWebhookPayload({ body: params.body, data: params.data });

    await Promise.all(tokens.map(async (t) => {
        const config = parseWebhookToken(t.token);
        if (!config) {
            // Only a CORRUPT blob (unparseable JSON / no url) is deleted. A
            // config that merely fails today's URL rules (rules can tighten
            // after it was saved) is skipped and kept — never silently drop a
            // user's saved webhook because validation changed.
            if (isWebhookTokenCorrupt(t.token)) {
                await pruneToken(t.id);
            } else {
                log({ module: 'push', level: 'warn', userId: params.userId }, 'Webhook config failed validation; skipped (kept)');
            }
            return;
        }
        if (!event || !payload) {
            log({ module: 'push', userId: params.userId, sessionId: params.sessionId }, 'Webhook skipped for unmapped event kind');
            return;
        }
        if (!config.events.includes(event)) {
            return; // User opted out of this event category.
        }
        await deliverAccountWebhook(params.userId, params.sessionId, config.url, payload);
    }));
}

/**
 * Device-only fan-out for non-session events (today: web-terminal agent
 * transitions arriving via POST /v1/webhook/notify). Same presence rule as
 * session events — an active tab suppresses device pushes — but no webhook
 * leg: the caller owns webhook delivery (and its event-subscription filter).
 * The webhook `events` config deliberately does NOT gate this: device pushes
 * are their own channel with their own on/off (the subscription itself),
 * mirroring how chat events treat the two channels independently.
 */
export async function dispatchDeviceEventPush(params: {
    userId: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
}): Promise<void> {
    const { userId, title, body } = params;
    const data = params.data ?? {};
    // sendExpo/sendWeb take a sessionId purely as a log label here.
    const label = typeof data.url === 'string' ? data.url : 'event';
    try {
        try {
            if (await isUserActive(userId)) {
                log({ module: 'push', userId, sessionId: label }, 'Suppressed device event push for active account');
                return;
            }
        } catch (presenceError) {
            log({ module: 'push', level: 'error', error: presenceError }, 'Presence check failed; sending push anyway');
        }
        const tokens = await db.accountPushToken.findMany({ where: { accountId: userId } });
        const expoTokens = tokens.filter(t => !t.token.startsWith(WEBHOOK_TOKEN_PREFIX) && !t.token.startsWith('webpush:'));
        const webTokens = tokens.filter(t => t.token.startsWith('webpush:'));
        if (expoTokens.length === 0 && webTokens.length === 0) return;
        await Promise.all([
            sendExpo({ userId, sessionId: label, title, body, data, channelId: 'messages' }, expoTokens),
            sendWeb({ userId, sessionId: label, title, body, data }, webTokens),
        ]);
    } catch (error) {
        log({ module: 'push', level: 'error', error }, 'Device event push dispatch failed');
    }
}

export async function dispatchSessionEventPush(params: {
    userId: string;
    sessionId: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
}): Promise<void> {
    const { userId, sessionId, title, body } = params;
    const data = { sessionId, ...(params.data ?? {}) };

    try {
        // ONE token fetch for every channel. Tokens are heterogeneous: account
        // webhooks are `webhook:`-prefixed, Web Push subscriptions are stored
        // as a `webpush:`-prefixed JSON blob, everything else is an Expo push
        // token. Splitting one findMany (instead of a second webhook-only
        // query) keeps the per-event DB cost at a single query even for users
        // with no webhook configured.
        const tokens = await db.accountPushToken.findMany({
            where: { accountId: userId }
        });
        const webhookTokens = tokens.filter(t => t.token.startsWith(WEBHOOK_TOKEN_PREFIX));
        const expoTokens = tokens.filter(t => !t.token.startsWith(WEBHOOK_TOKEN_PREFIX) && !t.token.startsWith('webpush:'));
        const webTokens = tokens.filter(t => t.token.startsWith('webpush:'));

        // Webhooks fire regardless of presence: they notify an external channel
        // (e.g. an IM group), not the device the user is looking at.
        // Fire-and-forget: a slow webhook target (up to the 5s fetch timeout)
        // must not delay device pushes below.
        void sendWebhooks({ userId, sessionId, body, data }, webhookTokens)
            .catch((error) => {
                log({ module: 'push', level: 'error', error }, 'Account webhook dispatch failed');
            });

        try {
            if (await isUserActive(userId)) {
                log({ module: 'push', userId, sessionId }, 'Suppressed device push for active account; webhooks already sent');
                return;
            }
        } catch (presenceError) {
            log({ module: 'push', level: 'error', error: presenceError }, 'Presence check failed; sending push anyway');
        }

        if (expoTokens.length === 0 && webTokens.length === 0) {
            log({ module: 'push', userId, sessionId }, 'No device push tokens; skipped');
            return;
        }

        await Promise.all([
            sendExpo({ userId, sessionId, title, body, data, channelId: 'messages' }, expoTokens),
            sendWeb({ userId, sessionId, title, body, data }, webTokens),
        ]);
    } catch (error) {
        log({ module: 'push', level: 'error', error }, 'Session-event push dispatch failed');
    }
}

/**
 * B-570: "send test notification" from settings. Web Push subscriptions only
 * (Expo app is retired; webhooks are a separate channel). NOT presence-
 * suppressed — the user is looking at the page that asked for it. Dead
 * subscriptions are pruned exactly like a real push.
 */
export async function sendTestWebPush(
    userId: string,
    copy: { title: string; body: string },
): Promise<WebPushFanoutResult & { configured: boolean }> {
    const tokens = await db.accountPushToken.findMany({
        where: { accountId: userId, token: { startsWith: 'webpush:' } },
    });
    const configured = webPushConfigured();
    if (!configured) {
        return { configured, total: tokens.length, sent: 0, failed: 0, pruned: 0 };
    }
    const res = await sendWeb({
        userId,
        sessionId: 'test',
        title: copy.title,
        body: copy.body,
        data: { kind: 'test', url: '/settings/notifications' },
    }, tokens);
    return { configured, ...res };
}
