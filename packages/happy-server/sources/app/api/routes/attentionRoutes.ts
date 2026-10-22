import { z } from 'zod';
import {
    AttentionItemListQuerySchema, AttentionItemOwnerRespondSchema, AttentionItemPatchSchema, AttentionItemPostSchema, AttentionItemResolveSchema,
} from '@slopus/happy-wire';
import type { Fastify } from '../types';
import { AttentionError } from '@/app/attention/rules';
import { listItems, ownerRespond, patchItem, postItem, resolveItem } from '@/app/attention/store';
import { TeamError } from '@/app/teams/reducer';

const params = z.object({ id: z.string().min(1).max(128) });

/**
 * B-766 briefing board REST (`specs/2026-10-owner-briefing.md`).
 * Account-authenticated. Errors are `{ error, ...details }`; with
 * `VH_OWNER_BOARD_ENABLED` unset every route answers 404
 * `owner_board_disabled`, the same "no board here" path as an older server.
 */
export function attentionRoutes(app: Fastify) {
    const handle = async (reply: any, work: () => Promise<unknown>) => {
        try {
            return await work();
        } catch (error) {
            if (error instanceof AttentionError) return reply.code(error.status).send({ error: error.code, ...(error.details ?? {}) });
            // Root-task accept / return refused by the team reducer (e.g. stale attempt).
            if (error instanceof TeamError) return reply.code(error.status).send({ error: error.code });
            throw error;
        }
    };
    const auth = { preHandler: app.authenticate };

    app.get('/v1/attention-items', { ...auth, schema: { querystring: AttentionItemListQuerySchema } },
        async (request, reply) => handle(reply, () => listItems(request.userId, request.query)));
    app.post('/v1/attention-items', { ...auth, schema: { body: AttentionItemPostSchema } },
        async (request, reply) => handle(reply, () => postItem(request.userId, request.body)));
    app.patch('/v1/attention-items/:id', { ...auth, schema: { params, body: AttentionItemPatchSchema } },
        async (request, reply) => handle(reply, () => patchItem(request.userId, request.params.id, request.body)));
    app.post('/v1/attention-items/:id/resolve', { ...auth, schema: { params, body: AttentionItemResolveSchema } },
        async (request, reply) => handle(reply, () => resolveItem(request.userId, request.params.id, request.body)));
    app.post('/v1/attention-items/:id/owner-respond', { ...auth, schema: { params, body: AttentionItemOwnerRespondSchema } },
        async (request, reply) => handle(reply, () => ownerRespond(request.userId, request.params.id, request.body)));
}
