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
 * indicators (unread dots, tab title counter) instead.
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
import { log } from "@/utils/log";

async function fetchTokensAndSend(params: {
    userId: string;
    sessionId: string;
    title: string;
    body: string;
    data: Record<string, unknown>;
    channelId: string;
}): Promise<void> {
    const tokens = await db.accountPushToken.findMany({
        where: { accountId: params.userId }
    });

    if (tokens.length === 0) {
        log({ module: 'push' }, `No push tokens for user ${params.userId} session ${params.sessionId} — skipped`);
        return;
    }

    // Tokens are heterogeneous: Web Push subscriptions are stored as a
    // `webpush:`-prefixed JSON blob, everything else is an Expo push token.
    const expoTokens = tokens.filter(t => !t.token.startsWith('webpush:'));
    const webTokens = tokens.filter(t => t.token.startsWith('webpush:'));

    await Promise.all([
        sendExpo(params, expoTokens),
        sendWeb(params, webTokens),
    ]);
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

export async function dispatchSessionEventPush(params: {
    userId: string;
    sessionId: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
}): Promise<void> {
    const { userId, sessionId, title, body, data } = params;

    try {
        try {
            if (await isUserActive(userId)) {
                log({ module: 'push' }, `Suppressed session-event push for user ${userId} session ${sessionId}: user active`);
                return;
            }
        } catch (presenceError) {
            log({ module: 'push', level: 'error' }, `Presence check failed, sending push anyway: ${presenceError}`);
        }

        await fetchTokensAndSend({
            userId,
            sessionId,
            title,
            body,
            data: { sessionId, ...(data ?? {}) },
            channelId: 'messages'
        });
    } catch (error) {
        log({ module: 'push', level: 'error' }, `Session-event push dispatch failed: ${error}`);
    }
}
