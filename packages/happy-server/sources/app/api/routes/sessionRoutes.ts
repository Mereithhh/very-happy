import { eventRouter, buildNewSessionUpdate, buildSessionActivityEphemeral, buildSessionArchivedAtUpdate } from "@/app/events/eventRouter";
import { type Fastify } from "../types";
import { db } from "@/storage/db";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { sessionDelete } from "@/app/session/sessionDelete";
import { isAccountResourceLimitError } from '../resourceLimits';
import { createSessionWithQuota, sessionCreateSchema } from '@/app/state/accountStateStore';
import { activityCache } from '@/app/presence/sessionCache';
import { allocateUserSeq } from '@/storage/seq';

/** B-265: one projection for the list and the by-id read, so the web sees the
 *  same shape (incl. the server-owned `archivedAt`) on both paths. */
const sessionProjection = {
    id: true,
    seq: true,
    createdAt: true,
    updatedAt: true,
    metadata: true,
    metadataVersion: true,
    agentState: true,
    agentStateVersion: true,
    dataEncryptionKey: true,
    active: true,
    lastActiveAt: true,
    archivedAt: true,
} as const;

function projectSession(v: {
    id: string; seq: number; createdAt: Date; updatedAt: Date; metadata: string; metadataVersion: number;
    agentState: string | null; agentStateVersion: number; dataEncryptionKey: Uint8Array | Buffer | null;
    active: boolean; lastActiveAt: Date; archivedAt: Date | null;
}) {
    return {
        id: v.id,
        seq: v.seq,
        createdAt: v.createdAt.getTime(),
        updatedAt: v.updatedAt.getTime(),
        active: v.active,
        activeAt: v.lastActiveAt.getTime(),
        archivedAt: v.archivedAt ? v.archivedAt.getTime() : null,
        metadata: v.metadata,
        metadataVersion: v.metadataVersion,
        agentState: v.agentState,
        agentStateVersion: v.agentStateVersion,
        dataEncryptionKey: v.dataEncryptionKey ? Buffer.from(v.dataEncryptionKey).toString('base64') : null,
        lastMessage: null as null,
    };
}

/** B-265: archive / unarchive fan-out to every user-scoped connection (web
 *  tabs, other devices). The session-scoped CLI socket is deliberately not a
 *  recipient — on archive it is being disconnected right now. */
async function emitArchivedAtUpdate(userId: string, sessionId: string, archivedAt: Date | null): Promise<void> {
    const updateSeq = await allocateUserSeq(userId);
    eventRouter.emitUpdate({
        userId,
        payload: buildSessionArchivedAtUpdate(sessionId, updateSeq, randomKeyNaked(12), archivedAt ? archivedAt.getTime() : null),
        recipientFilter: { type: 'user-scoped-only' },
    });
}

export function sessionRoutes(app: Fastify) {

    // Sessions API
    app.get('/v1/sessions', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;

        const sessions = await db.session.findMany({
            where: { accountId: userId },
            orderBy: { updatedAt: 'desc' },
            take: 150,
            select: sessionProjection,
        });

        return reply.send({ sessions: sessions.map(projectSession) });
    });

    // B-265: one session by id, same projection as the list. Lets a resuming
    // CLI / daemon read the current `seq` + metadata of a session that has
    // fallen out of the list's 150-row window.
    app.get('/v1/sessions/:sessionId', {
        schema: {
            params: z.object({ sessionId: z.string() })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const session = await db.session.findFirst({
            where: { id: request.params.sessionId, accountId: request.userId },
            select: sessionProjection,
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }
        return reply.send({ session: projectSession(session) });
    });

    // V2 Sessions API - Active sessions only
    app.get('/v2/sessions/active', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                limit: z.coerce.number().int().min(1).max(500).default(150)
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const limit = request.query?.limit || 150;

        const sessions = await db.session.findMany({
            where: {
                accountId: userId,
                active: true,
                lastActiveAt: { gt: new Date(Date.now() - 1000 * 60 * 15) /* 15 minutes */ }
            },
            orderBy: { lastActiveAt: 'desc' },
            take: limit,
            select: {
                id: true,
                seq: true,
                createdAt: true,
                updatedAt: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                dataEncryptionKey: true,
                active: true,
                lastActiveAt: true,
            }
        });

        return reply.send({
            sessions: sessions.map((v) => ({
                id: v.id,
                seq: v.seq,
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime(),
                active: v.active,
                activeAt: v.lastActiveAt.getTime(),
                metadata: v.metadata,
                metadataVersion: v.metadataVersion,
                agentState: v.agentState,
                agentStateVersion: v.agentStateVersion,
                dataEncryptionKey: v.dataEncryptionKey ? Buffer.from(v.dataEncryptionKey).toString('base64') : null,
            }))
        });
    });

    // V2 Sessions API - Cursor-based pagination with change tracking
    app.get('/v2/sessions', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                cursor: z.string().optional(),
                limit: z.coerce.number().int().min(1).max(200).default(50),
                changedSince: z.coerce.number().int().positive().optional()
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { cursor, limit = 50, changedSince } = request.query || {};

        // Decode cursor - simple ID-based cursor
        let cursorSessionId: string | undefined;
        if (cursor) {
            if (cursor.startsWith('cursor_v1_')) {
                cursorSessionId = cursor.substring(10);
            } else {
                return reply.code(400).send({ error: 'Invalid cursor format' });
            }
        }

        // Build where clause
        const where: Prisma.SessionWhereInput = { accountId: userId };

        // Add changedSince filter (just a filter, doesn't affect pagination)
        if (changedSince) {
            where.updatedAt = {
                gt: new Date(changedSince)
            };
        }

        // Add cursor pagination - always by ID descending (most recent first)
        if (cursorSessionId) {
            where.id = {
                lt: cursorSessionId  // Get sessions with ID less than cursor (for desc order)
            };
        }

        // Always sort by ID descending for consistent pagination
        const orderBy = { id: 'desc' as const };

        const sessions = await db.session.findMany({
            where,
            orderBy,
            take: limit + 1, // Fetch one extra to determine if there are more
            select: {
                id: true,
                seq: true,
                createdAt: true,
                updatedAt: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                dataEncryptionKey: true,
                active: true,
                lastActiveAt: true,
            }
        });

        // Check if there are more results
        const hasNext = sessions.length > limit;
        const resultSessions = hasNext ? sessions.slice(0, limit) : sessions;

        // Generate next cursor - simple ID-based cursor
        let nextCursor: string | null = null;
        if (hasNext && resultSessions.length > 0) {
            const lastSession = resultSessions[resultSessions.length - 1];
            nextCursor = `cursor_v1_${lastSession.id}`;
        }

        return reply.send({
            sessions: resultSessions.map((v) => ({
                id: v.id,
                seq: v.seq,
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime(),
                active: v.active,
                activeAt: v.lastActiveAt.getTime(),
                metadata: v.metadata,
                metadataVersion: v.metadataVersion,
                agentState: v.agentState,
                agentStateVersion: v.agentStateVersion,
                dataEncryptionKey: v.dataEncryptionKey ? Buffer.from(v.dataEncryptionKey).toString('base64') : null,
            })),
            nextCursor,
            hasNext
        });
    });

    // Create or load session by tag
    app.post('/v1/sessions', {
        schema: {
            body: sessionCreateSchema,
            response: {
                200: z.object({
                    session: z.object({
                        id: z.string(),
                        seq: z.number(),
                        metadata: z.string(),
                        metadataVersion: z.number(),
                        agentState: z.string().nullable(),
                        agentStateVersion: z.number(),
                        dataEncryptionKey: z.string().nullable(),
                        active: z.boolean(),
                        activeAt: z.number(),
                        createdAt: z.number(),
                        updatedAt: z.number(),
                        lastMessage: z.null(),
                    }),
                }),
                413: z.object({ error: z.literal('session_state_bytes_quota_exceeded') }),
                429: z.union([
                    z.object({ error: z.literal('session_state_rate_quota_exceeded') }),
                    z.object({ error: z.literal('limit-reached'), resource: z.literal('sessions'), limit: z.number() }),
                ]),
            },
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { tag, metadata, agentState, dataEncryptionKey } = request.body;

        try {
            const result = await createSessionWithQuota({ accountId: userId, tag, metadata, agentState, dataEncryptionKey });
            if (result.kind === 'count-limit') {
                return reply.code(429).send({ error: 'limit-reached', resource: 'sessions', limit: result.limit });
            }
            const { session, updateSeq } = result;
            log({ module: 'session-create', sessionId: session.id, userId, tag, created: result.created }, 'Session create completed');

            // Emit new session update
            if (updateSeq !== null) {
                const updatePayload = buildNewSessionUpdate(session, updateSeq, randomKeyNaked(12));
                log({
                    module: 'session-create',
                    userId,
                    sessionId: session.id,
                    updateType: 'new-session'
                }, `Emitting new-session update to user-scoped connections`);
                eventRouter.emitUpdate({
                    userId,
                    payload: updatePayload,
                    recipientFilter: { type: 'user-scoped-only' }
                });
            }

            return reply.send({
                session: {
                    id: session.id,
                    seq: session.seq,
                    metadata: session.metadata,
                    metadataVersion: session.metadataVersion,
                    agentState: session.agentState,
                    agentStateVersion: session.agentStateVersion,
                    dataEncryptionKey: session.dataEncryptionKey ? Buffer.from(session.dataEncryptionKey).toString('base64') : null,
                    active: session.active,
                    activeAt: session.lastActiveAt.getTime(),
                    createdAt: session.createdAt.getTime(),
                    updatedAt: session.updatedAt.getTime(),
                    lastMessage: null
                }
            });
        } catch (error) {
            if (isAccountResourceLimitError(error)) {
                return reply.code(error.statusCode).send({ error: error.code as any });
            }
            throw error;
        }
    });

    app.get('/v1/sessions/:sessionId/messages', {
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        // Verify session belongs to user
        const session = await db.session.findFirst({
            where: {
                id: sessionId,
                accountId: userId
            }
        });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        const messages = await db.sessionMessage.findMany({
            where: { sessionId },
            orderBy: { createdAt: 'desc' },
            take: 150,
            select: {
                id: true,
                seq: true,
                localId: true,
                content: true,
                createdAt: true,
                updatedAt: true
            }
        });

        return reply.send({
            messages: messages.map((v) => ({
                id: v.id,
                seq: v.seq,
                content: v.content,
                localId: v.localId,
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime()
            }))
        });
    });

    // Archive session (force deactivate)
    app.post('/v1/sessions/archive-status', {
        schema: {
            body: z.object({ sessionIds: z.array(z.string()).max(500) })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const rows = await db.session.findMany({
            where: {
                accountId: request.userId,
                id: { in: request.body.sessionIds },
                archivedAt: { not: null },
            },
            select: { id: true },
        });
        return reply.send({ archivedSessionIds: rows.map((row) => row.id) });
    });

    // Archive session (force deactivate)
    app.post('/v1/sessions/:sessionId/archive', {
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        const archivedAt = new Date();
        const result = await db.session.updateMany({
            where: { id: sessionId, accountId: userId },
            data: { archivedAt, active: false, lastActiveAt: archivedAt }
        });

        if (result.count === 0) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        activityCache.discardSessionUpdate(sessionId);
        eventRouter.emitSessionArchived(userId, sessionId);
        await emitArchivedAtUpdate(userId, sessionId, archivedAt);

        // Notify all clients about the session deactivation
        const sessionActivity = buildSessionActivityEphemeral(sessionId, false, Date.now(), false);
        eventRouter.emitEphemeral({
            userId,
            payload: sessionActivity,
            recipientFilter: { type: 'user-scoped-only' }
        });

        return reply.send({ success: true });
    });

    // Explicit reverse transition used only by intentional resume flows.
    app.post('/v1/sessions/:sessionId/unarchive', {
        schema: {
            params: z.object({ sessionId: z.string() })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const { sessionId } = request.params;
        const result = await db.session.updateMany({
            where: { id: sessionId, accountId: request.userId },
            data: { archivedAt: null, active: false, lastActiveAt: new Date() }
        });
        if (result.count === 0) return reply.code(404).send({ error: 'Session not found' });
        await emitArchivedAtUpdate(request.userId, sessionId, null);
        return reply.send({ success: true });
    });

    // Delete session
    app.delete('/v1/sessions/:sessionId', {
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        const deleted = await sessionDelete({ uid: userId }, sessionId);

        if (!deleted) {
            return reply.code(404).send({ error: 'Session not found or not owned by user' });
        }

        return reply.send({ success: true });
    });
}
