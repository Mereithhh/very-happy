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
import { parseWebPushToken, sendWebPush } from "@/app/push/webPush";
import {
    WEBHOOK_TOKEN_PREFIX,
    buildWebhookPayload,
    logWebhookResult,
    mapKindToWebhookEvent,
    parseWebhookToken,
    sendWebhook,
} from "@/app/push/webhookNotify";
import { log } from "@/utils/log";

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
            void db.accountPushToken.deleteMany({
                where: { id: tokens[i].id }
            });
        }
    }

    if (errors.length === 0) {
        log({ module: 'push' }, `Expo push sent for user ${params.userId} session ${params.sessionId}: ${okCount} token(s)`);
    } else {
        log({ module: 'push', level: 'warn' }, `Expo push partial for user ${params.userId} session ${params.sessionId}: ok=${okCount} errors=${JSON.stringify(errors)}`);
    }
}

async function sendWeb(
    params: { userId: string; sessionId: string; title: string; body: string; data: Record<string, unknown> },
    tokens: { id: string; token: string }[],
): Promise<void> {
    if (tokens.length === 0) return;

    let okCount = 0;
    let gone = 0;
    await Promise.all(tokens.map(async (t) => {
        const sub = parseWebPushToken(t.token);
        if (!sub) {
            // Malformed stored subscription — prune it.
            void db.accountPushToken.deleteMany({ where: { id: t.id } });
            return;
        }
        const res = await sendWebPush(sub, {
            title: params.title,
            body: params.body,
            data: { sessionId: params.sessionId, ...params.data },
        });
        if (res.ok) okCount++;
        if (res.gone) {
            gone++;
            void db.accountPushToken.deleteMany({ where: { id: t.id } });
        }
    }));

    log({ module: 'push' }, `Web push for user ${params.userId} session ${params.sessionId}: ok=${okCount} pruned=${gone} of ${tokens.length}`);
}

/**
 * Account webhooks: POST a generic `{title, message}` JSON to the user's own
 * endpoint (e.g. a notify-gateway ingest URL that forwards to a group chat).
 * Same trigger as the other push channels but PRESENCE-INDEPENDENT: an open
 * happy tab suppresses device pushes, never webhooks — the external channel
 * must hear about completions either way. Best-effort — failures are logged,
 * never retried, never thrown.
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
            // Malformed stored webhook config — prune it (mirrors web push).
            void db.accountPushToken.deleteMany({ where: { id: t.id } });
            return;
        }
        if (!event || !payload) {
            log({ module: 'push' }, `Webhook skipped for user ${params.userId} session ${params.sessionId}: unmapped kind ${String(params.data.kind)}`);
            return;
        }
        if (!config.events.includes(event)) {
            return; // User opted out of this event category.
        }
        const res = await sendWebhook(config.url, payload);
        logWebhookResult(params.userId, params.sessionId, res);
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
                log({ module: 'push' }, `Suppressed device event push for user ${userId} (${label}): user active`);
                return;
            }
        } catch (presenceError) {
            log({ module: 'push', level: 'error' }, `Presence check failed, sending push anyway: ${presenceError}`);
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
        log({ module: 'push', level: 'error' }, `Device event push dispatch failed: ${error}`);
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
                log({ module: 'push', level: 'error' }, `Account webhook dispatch failed: ${error}`);
            });

        try {
            if (await isUserActive(userId)) {
                log({ module: 'push' }, `Suppressed session-event push for user ${userId} session ${sessionId}: user active (device pushes only; webhooks already sent)`);
                return;
            }
        } catch (presenceError) {
            log({ module: 'push', level: 'error' }, `Presence check failed, sending push anyway: ${presenceError}`);
        }

        if (expoTokens.length === 0 && webTokens.length === 0) {
            log({ module: 'push' }, `No push tokens for user ${userId} session ${sessionId} — skipped`);
            return;
        }

        await Promise.all([
            sendExpo({ userId, sessionId, title, body, data, channelId: 'messages' }, expoTokens),
            sendWeb({ userId, sessionId, title, body, data }, webTokens),
        ]);
    } catch (error) {
        log({ module: 'push', level: 'error' }, `Session-event push dispatch failed: ${error}`);
    }
}
