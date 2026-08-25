import { getMetricsLabelsFromSocket, sessionAliveEventsCounter, websocketEventsCounter } from "@/app/monitoring/metrics2";
import { activityCache } from "@/app/presence/sessionCache";
import { buildNewMessageUpdate, buildSessionActivityEphemeral, buildUpdateSessionUpdate, ClientConnection, eventRouter } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { AsyncLock } from "@/utils/lock";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { Socket } from "socket.io";
import { isAccountResourceLimitError } from '../resourceLimits';
import {
    SESSION_MESSAGE_CONTENT_MAX_BYTES,
    SESSION_MESSAGE_LOCAL_ID_MAX_BYTES,
    storeSessionMessages,
} from '../sessionMessageStore';
import { updateSessionStateWithQuota } from '@/app/state/accountStateStore';

export function ownsSessionLifecycle(connection: ClientConnection, sessionId: string): boolean {
    return connection.connectionType === 'session-scoped' && connection.sessionId === sessionId;
}

export function sessionUpdateHandler(userId: string, socket: Socket, connection: ClientConnection) {
    const labels = getMetricsLabelsFromSocket(socket);
    socket.on('update-metadata', async (data: any, callback: (response: any) => void) => {
        try {
            const result = await updateSessionStateWithQuota({
                accountId: userId,
                sessionId: data?.sid,
                field: 'metadata',
                value: data?.metadata,
                expectedVersion: data?.expectedVersion,
            });
            if (result.kind === 'not-found') {
                callback?.({ result: 'error' });
                return;
            }
            if (result.kind === 'version-mismatch') {
                callback?.({
                    result: 'version-mismatch',
                    version: result.session.metadataVersion,
                    metadata: result.session.metadata,
                });
                return;
            }

            // Generate session metadata update
            const metadataUpdate = {
                value: result.session.metadata,
                version: result.session.metadataVersion,
            };
            const updatePayload = buildUpdateSessionUpdate(result.session.id, result.updateSeq, randomKeyNaked(12), metadataUpdate);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'all-interested-in-session', sessionId: result.session.id }
            });

            callback?.({ result: 'success', version: result.session.metadataVersion, metadata: result.session.metadata });
        } catch (error) {
            if (isAccountResourceLimitError(error)) {
                callback?.({ result: 'error', error: error.code });
                return;
            }
            log({ module: 'websocket', level: 'error', error }, 'Error in update-metadata');
            callback?.({ result: 'error' });
        }
    });

    socket.on('update-state', async (data: any, callback: (response: any) => void) => {
        try {
            const result = await updateSessionStateWithQuota({
                accountId: userId,
                sessionId: data?.sid,
                field: 'agentState',
                value: data?.agentState,
                expectedVersion: data?.expectedVersion,
            });
            if (result.kind === 'not-found') {
                callback?.({ result: 'error' });
                return;
            }
            if (result.kind === 'version-mismatch') {
                callback?.({
                    result: 'version-mismatch',
                    version: result.session.agentStateVersion,
                    agentState: result.session.agentState,
                });
                return;
            }

            // Generate session agent state update
            const agentStateUpdate = {
                value: result.session.agentState,
                version: result.session.agentStateVersion,
            };
            const updatePayload = buildUpdateSessionUpdate(result.session.id, result.updateSeq, randomKeyNaked(12), undefined, agentStateUpdate);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'all-interested-in-session', sessionId: result.session.id }
            });

            callback?.({ result: 'success', version: result.session.agentStateVersion, agentState: result.session.agentState });
        } catch (error) {
            if (isAccountResourceLimitError(error)) {
                callback?.({ result: 'error', error: error.code });
                return;
            }
            log({ module: 'websocket', level: 'error', error }, 'Error in update-state');
            callback?.({ result: 'error' });
        }
    });
    socket.on('session-alive', async (data: {
        sid: string;
        time: number;
        thinking?: boolean;
    }) => {
        try {
            // Track metrics
            websocketEventsCounter.inc({ event_type: 'session-alive', ...labels });
            sessionAliveEventsCounter.inc();

            // Basic validation
            if (!data || typeof data.time !== 'number' || !data.sid) {
                return;
            }

            let t = data.time;
            if (t > Date.now()) {
                t = Date.now();
            }
            if (t < Date.now() - 1000 * 60 * 10) {
                return;
            }

            const { sid, thinking } = data;
            if (!ownsSessionLifecycle(connection, sid)) return;

            // Check session validity using cache
            const isValid = await activityCache.isSessionValid(sid, userId);
            if (!isValid) {
                return;
            }

            // Queue database update (will only update if time difference is significant)
            activityCache.queueSessionUpdate(sid, t);

            // Emit session activity update
            const sessionActivity = buildSessionActivityEphemeral(sid, true, t, thinking || false);
            eventRouter.emitEphemeral({
                userId,
                payload: sessionActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error', error }, 'Error in session-alive');
        }
    });

    const receiveMessageLock = new AsyncLock();
    socket.on('message', async (data: any) => {
        await receiveMessageLock.inLock(async () => {
            try {
                websocketEventsCounter.inc({ event_type: 'message', ...labels });
                const { sid, message, localId } = data;

                if (typeof sid !== 'string' || typeof message !== 'string') return;
                if (Buffer.byteLength(message, 'utf8') > SESSION_MESSAGE_CONTENT_MAX_BYTES) return;
                if (typeof localId === 'string' && Buffer.byteLength(localId, 'utf8') > SESSION_MESSAGE_LOCAL_ID_MAX_BYTES) return;

                log({
                    module: 'websocket',
                    socketId: socket.id,
                    sessionId: sid,
                    contentBytes: Buffer.byteLength(message, 'utf8'),
                    connectionType: connection.connectionType,
                    connectionSessionId: connection.connectionType === 'session-scoped' ? connection.sessionId : undefined,
                }, 'Received session message');

                // Resolve session
                const session = await db.session.findUnique({
                    where: { id: sid, accountId: userId }
                });
                if (!session) {
                    return;
                }
                let stored;
                try {
                    stored = await storeSessionMessages({
                        accountId: userId,
                        sessionId: sid,
                        messages: [{ content: message, localId: typeof localId === 'string' ? localId : null }],
                    });
                } catch (error) {
                    if (isAccountResourceLimitError(error)) {
                        log({ module: 'websocket', level: 'warn', userId, code: error.code }, 'Dropping session message');
                        return;
                    }
                    throw error;
                }
                const created = stored.createdMessages[0];
                if (!created) return;
                const { updateSeq: updSeq, ...msg } = created;

                // Emit new message update to relevant clients
                const updatePayload = buildNewMessageUpdate(msg, sid, updSeq, randomKeyNaked(12));
                eventRouter.emitUpdate({
                    userId,
                    payload: updatePayload,
                    recipientFilter: { type: 'all-interested-in-session', sessionId: sid },
                    skipSenderConnection: connection
                });
            } catch (error) {
                log({ module: 'websocket', level: 'error', error }, 'Error in message handler');
            }
        });
    });

    socket.on('session-end', async (data: {
        sid: string;
        time: number;
    }) => {
        try {
            const { sid, time } = data;
            if (!ownsSessionLifecycle(connection, sid)) return;
            let t = time;
            if (typeof t !== 'number') {
                return;
            }
            if (t > Date.now()) {
                t = Date.now();
            }
            if (t < Date.now() - 1000 * 60 * 10) { // Ignore if time is in the past 10 minutes
                return;
            }

            // Resolve session
            const session = await db.session.findUnique({
                where: { id: sid, accountId: userId }
            });
            if (!session) {
                return;
            }

            // Update last active at
            await db.session.update({
                where: { id: sid },
                data: { lastActiveAt: new Date(t), active: false }
            });

            // Emit session activity update
            const sessionActivity = buildSessionActivityEphemeral(sid, false, t, false);
            eventRouter.emitEphemeral({
                userId,
                payload: sessionActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error', error }, 'Error in session-end');
        }
    });

}
