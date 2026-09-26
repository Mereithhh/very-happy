import { z } from 'zod';
import { PromptQueueEnqueueSchema, PromptQueueOrderSchema, PromptQueueUpdateContentSchema } from '@slopus/happy-wire';
import type { Fastify } from '../types';
import { isAccountResourceLimitError } from '@/app/api/resourceLimits';
import {
    dispatchPromptQueueHead, enqueuePrompt, listPromptQueue, PromptQueueError, removePrompt, reorderPromptQueue, updatePromptContent,
} from '@/app/promptQueue/store';

const sessionParams = z.object({ sessionId: z.string().min(1).max(128) });
const itemParams = sessionParams.extend({ itemId: z.string().min(1).max(128) });

/**
 * B-509 server-side prompt queue REST (spec `specs/2026-09-server-prompt-queue.md`).
 * Account-authenticated; a session the account does not own is 404. Errors are
 * `{ error, ...details }`. `dispatch` is what the session's wrapper calls when
 * its own input queue is empty; a client may call it too, it is just a pop.
 */
export function promptQueueRoutes(app: Fastify) {
    const handle = async (reply: any, work: () => Promise<unknown>) => {
        try { return await work(); }
        catch (error) {
            if (error instanceof PromptQueueError) return reply.code(error.status).send({ error: error.code, ...(error.details ?? {}) });
            if (isAccountResourceLimitError(error)) return reply.code(error.statusCode).send({ error: error.code });
            throw error;
        }
    };
    const auth = { preHandler: app.authenticate };
    app.get('/v1/sessions/:sessionId/prompt-queue', { ...auth, schema: { params: sessionParams } }, async (request, reply) => handle(reply, async () => ({ items: await listPromptQueue(request.userId, request.params.sessionId) })));
    app.post('/v1/sessions/:sessionId/prompt-queue', { ...auth, schema: { params: sessionParams, body: PromptQueueEnqueueSchema } }, async (request, reply) => handle(reply, () => enqueuePrompt(request.userId, request.params.sessionId, request.body)));
    // Static segments before `/:itemId` so `order` and `dispatch` never resolve as item ids.
    app.put('/v1/sessions/:sessionId/prompt-queue/order', { ...auth, schema: { params: sessionParams, body: PromptQueueOrderSchema } }, async (request, reply) => handle(reply, () => reorderPromptQueue(request.userId, request.params.sessionId, request.body.ids)));
    app.post('/v1/sessions/:sessionId/prompt-queue/dispatch', { ...auth, schema: { params: sessionParams } }, async (request, reply) => handle(reply, () => dispatchPromptQueueHead(request.userId, request.params.sessionId)));
    app.patch('/v1/sessions/:sessionId/prompt-queue/:itemId', { ...auth, schema: { params: itemParams, body: PromptQueueUpdateContentSchema } }, async (request, reply) => handle(reply, () => updatePromptContent(request.userId, request.params.sessionId, request.params.itemId, request.body.content)));
    app.delete('/v1/sessions/:sessionId/prompt-queue/:itemId', { ...auth, schema: { params: itemParams } }, async (request, reply) => handle(reply, () => removePrompt(request.userId, request.params.sessionId, request.params.itemId)));
}
