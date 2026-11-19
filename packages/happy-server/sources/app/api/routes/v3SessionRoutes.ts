import { countPeerMessage } from '@/app/monitoring/projectMetrics';
import { buildNewMessageUpdate, eventRouter } from "@/app/events/eventRouter";
import { noteSessionMessage } from '@/app/automations/attentionLifecycle';
import { configuredResourceLimit, isAccountResourceLimitError } from "@/app/api/resourceLimits";
import { utf8StringSchema } from "@/app/api/resourceSchemas";
import {
    SESSION_MESSAGE_CONTENT_MAX_BYTES,
    SESSION_MESSAGE_LOCAL_ID_MAX_BYTES,
    storeSessionMessages,
} from "@/app/api/sessionMessageStore";
import { db } from "@/storage/db";
import { warn } from "@/utils/log";
import { inTx } from "@/storage/inTx";
import { closeSessionBackfill, declareSessionBackfill } from "@/app/api/sessionBackfill";
import { resolveSessionAccess } from "@/app/session/sessionShares";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { z } from "zod";
import { type Fastify } from "../types";

// Pagination contract:
//   - after_seq=N  → forward sync: messages with seq > N, ordered ASC.
//                    Used by the client to pull anything new since the highest
//                    seq it has already seen.
//   - before_seq=N → backward paging: messages with seq < N, ordered DESC.
//                    Used by the client to lazy-load older history when the
//                    user scrolls up, so opening a long session does not block
//                    on fetching the entire history first.
// The two are mutually exclusive. With neither, the route defaults to
// `after_seq=0` (forward from the start) for backward compatibility.
const getMessagesQuerySchema = z.object({
    after_seq: z.coerce.number().int().min(0).optional(),
    before_seq: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100)
}).refine(
    (data) => !(data.after_seq !== undefined && data.before_seq !== undefined),
    { message: "after_seq and before_seq are mutually exclusive" }
);

/**
 * B-942: a session wrapper's outbox is FIFO, and before CLI 0.2.2xx (B-880) it
 * posted 50 messages per request whatever their size and retried every error
 * forever. One batch over the 1 MiB server-wide body limit then answered 413
 * on every retry and held back everything the session wrote after it — a Codex
 * wrapper on 0.2.178 retried the same batch for 7 hours while it answered three
 * more prompts that never reached anyone. Wrappers do not pick up a daemon
 * upgrade (and that machine never upgraded), so the server takes such a batch:
 * this route reads up to 16 MiB, stores every message within the per-message
 * limit and skips — for a wrapper only — the ones over it, so its queue moves
 * on. Other clients still get the 413 they always got for an oversize message
 * (the Web shows it as failed; an answer without its ack would leave the Web
 * resending it forever).
 */
export const SESSION_MESSAGES_BODY_LIMIT_BYTES = 16 * 1024 * 1024;

export function sessionMessagesBodyLimit(): number {
    const configured = configuredResourceLimit('HTTP_SESSION_MESSAGES_BODY_LIMIT_BYTES', SESSION_MESSAGES_BODY_LIMIT_BYTES);
    return configured === 0 ? Number.MAX_SAFE_INTEGER : configured;
}

/** B-942: the client is a session wrapper (`cli-coding-session/<version>`), whose outbox blocks on a refusal. */
export function isSessionWrapperClient(header: unknown): boolean {
    return typeof header === 'string' && header.startsWith('cli-coding-session/');
}

/** B-942: split a batch into what can be stored and what is over the per-message limit. */
export function partitionOversizeMessages<T extends { content: string }>(messages: readonly T[]): { fits: T[]; oversize: T[] } {
    const fits: T[] = [];
    const oversize: T[] = [];
    for (const message of messages) {
        (Buffer.byteLength(message.content, 'utf8') > SESSION_MESSAGE_CONTENT_MAX_BYTES ? oversize : fits).push(message);
    }
    return { fits, oversize };
}

const sendMessagesBodySchema = z.object({
    messages: z.array(z.object({
        // B-942: the per-message limit is applied in the handler (partitionOversizeMessages).
        content: z.string(),
        localId: utf8StringSchema({ minBytes: 1, maxBytes: SESSION_MESSAGE_LOCAL_ID_MAX_BYTES })
    })).min(1).max(100)
});

type SelectedMessage = {
    id: string;
    seq: number;
    content: unknown;
    localId: string | null;
    createdAt: Date;
    updatedAt: Date;
};

function toResponseMessage(message: SelectedMessage) {
    return {
        id: message.id,
        seq: message.seq,
        content: message.content,
        localId: message.localId,
        createdAt: message.createdAt.getTime(),
        updatedAt: message.updatedAt.getTime()
    };
}

function toSendResponseMessage(message: Omit<SelectedMessage, "content">) {
    return {
        id: message.id,
        seq: message.seq,
        localId: message.localId,
        createdAt: message.createdAt.getTime(),
        updatedAt: message.updatedAt.getTime()
    };
}

export function v3SessionRoutes(app: Fastify) {
    app.get('/v3/sessions/:sessionId/messages', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            querystring: getMessagesQuerySchema
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { after_seq, before_seq, limit } = request.query;

        // Owner, or an account the session is shared with (B-619): both read the same ciphertext.
        const access = await resolveSessionAccess(userId, sessionId);
        if (!access) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // Backward direction is opt-in via `before_seq`; everything else (no
        // params, or explicit `after_seq`) keeps the legacy forward semantics.
        const isBackward = before_seq !== undefined;
        const where = isBackward
            ? { sessionId, seq: { lt: before_seq } }
            : { sessionId, seq: { gt: after_seq ?? 0 } };
        const orderBy = isBackward
            ? { seq: 'desc' as const }
            : { seq: 'asc' as const };

        const messages = await db.sessionMessage.findMany({
            where,
            orderBy,
            take: limit + 1,
            select: {
                id: true,
                seq: true,
                content: true,
                localId: true,
                createdAt: true,
                updatedAt: true
            }
        });

        const hasMore = messages.length > limit;
        const page = hasMore ? messages.slice(0, limit) : messages;

        return reply.send({
            messages: page.map(toResponseMessage),
            hasMore
        });
    });

    app.post('/v3/sessions/:sessionId/messages', {
        preHandler: app.authenticate,
        bodyLimit: sessionMessagesBodyLimit(),
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            body: sendMessagesBodySchema
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { fits: messages, oversize } = partitionOversizeMessages(request.body.messages);
        const wrapper = isSessionWrapperClient(request.headers['x-happy-client']);
        if (oversize.length > 0 && !wrapper) {
            return reply.code(413).send({ error: 'message_too_large' });
        }

        const session = await db.session.findFirst({
            where: {
                id: sessionId,
                accountId: userId
            },
            select: { id: true }
        });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        const firstMessageByLocalId = new Map<string, { localId: string; content: string }>();
        for (const message of messages) {
            if (!firstMessageByLocalId.has(message.localId)) {
                firstMessageByLocalId.set(message.localId, message);
            }
        }

        const uniqueMessages = Array.from(firstMessageByLocalId.values());
        if (oversize.length > 0) {
            warn({ module: 'session-messages', sessionId, skipped: oversize.length, bytes: oversize.map((message) => Buffer.byteLength(message.content, 'utf8')) }, 'B-942: skipped session messages over the per-message limit from a wrapper');
        }
        if (uniqueMessages.length === 0) {
            return reply.send({ messages: [] });
        }
        let stored;
        try {
            stored = await storeSessionMessages({
                accountId: userId,
                sessionId,
                messages: uniqueMessages,
                backfill: request.headers['x-happy-message-origin'] === 'backfill',
            });
        } catch (error) {
            if (isAccountResourceLimitError(error)) {
                return reply.code(error.statusCode).send({ error: error.code });
            }
            throw error;
        }

        // B-508: owner-authored messages (judged on client tag + localId prefix) resolve attention runs about this session.
        const firstCreated = stored.createdMessages[0];
        // B-651 ③: count session-to-session messages (plaintext marker = localId prefix), split by project membership.
        if (firstCreated?.localId?.startsWith('session-message-')) {
            void Promise.resolve().then(() => db.projectMember.count({ where: { sessionId } })).then((n) => countPeerMessage(firstCreated.localId, n > 0)).catch(() => undefined);
        }
        if (firstCreated) {
            const origin = { accountId: userId, sessionId, localId: firstCreated.localId, client: request.headers['x-happy-client'] as string | undefined, origin: request.headers['x-happy-message-origin'] as string | undefined };
            void noteSessionMessage(origin);
        }
        for (const message of stored.createdMessages) {
            const { updateSeq, ...storedMessage } = message;
            const updatePayload = buildNewMessageUpdate(
                storedMessage,
                sessionId,
                updateSeq,
                randomKeyNaked(12),
            );

            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'all-interested-in-session', sessionId }
            });
        }

        return reply.send({
            messages: stored.messages.map(toSendResponseMessage)
        });
    });

    // B-880: declare (before the first message) or close a history backfill — sessionBackfill.ts.
    app.post('/v3/sessions/:sessionId/backfill', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ sessionId: z.string() }),
            body: z.union([
                z.object({ total: z.number().int().min(1).max(10_000_000) }),
                z.object({ done: z.literal(true) }),
            ]),
        },
    }, async (request, reply) => {
        const accountId = request.userId;
        const { sessionId } = request.params;
        const body = request.body;
        if ('done' in body) {
            const closed = await inTx((tx) => closeSessionBackfill(tx, { accountId, sessionId }));
            return reply.send({ closed });
        }
        const result = await inTx((tx) => declareSessionBackfill(tx, { accountId, sessionId, total: body.total }));
        if (result.ok) return reply.send({ quota: result.quota });
        if (result.reason === 'not-found') return reply.code(404).send({ error: 'Session not found' });
        return reply.code(409).send({ error: 'backfill_not_allowed', reason: result.reason });
    });
}

