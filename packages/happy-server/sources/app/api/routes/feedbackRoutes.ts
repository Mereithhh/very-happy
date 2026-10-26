import { z } from 'zod';
import type { Fastify } from '../types';
import { enforceAccountWriteRate, isAccountResourceLimitError } from '@/app/api/resourceLimits';
import { FeedbackAmendSchema, FeedbackError, FeedbackListQuerySchema, FeedbackPostSchema, FeedbackReadSchema, isFeedbackAdmin } from '@/app/feedback/rules';
import { amendFeedback, listFeedback, markFeedbackRead, postFeedback } from '@/app/feedback/store';

const params = z.object({ id: z.string().min(1).max(64) });
/** Rating + 2000 characters + whitelisted diagnostics fit comfortably; anything bigger is not feedback. */
const FEEDBACK_BODY_LIMIT = 16 * 1024;

/**
 * B-836 in-app feedback (`specs/2026-10-feedback.md`). Any signed-in account
 * can send; only `VH_FEEDBACK_ADMIN_ACCOUNT_IDS` can read, and everyone else
 * gets the same 404 an older server gives. Errors are `{ error }`.
 */
export function feedbackRoutes(app: Fastify) {
    const handle = async (reply: any, work: () => Promise<unknown>) => {
        try {
            return await work();
        } catch (error) {
            if (error instanceof FeedbackError) return reply.code(error.status).send({ error: error.code });
            if (isAccountResourceLimitError(error)) return reply.code(error.statusCode).send({ error: 'feedback_rate_limited' });
            throw error;
        }
    };
    const auth = { preHandler: app.authenticate, bodyLimit: FEEDBACK_BODY_LIMIT };

    app.post('/v1/feedback', { ...auth, schema: { body: FeedbackPostSchema } },
        async (request, reply) => handle(reply, () => postFeedback(request.userId, request.body)));
    app.patch('/v1/feedback/:id', { ...auth, schema: { params, body: FeedbackAmendSchema } },
        async (request, reply) => handle(reply, async () => {
            await enforceAccountWriteRate({ accountId: request.userId, resource: 'feedback', envName: 'MAX_FEEDBACK_EDITS_PER_ACCOUNT_PER_MINUTE', fallback: 20 });
            return amendFeedback(request.userId, request.params.id, request.body);
        }));
    app.get('/v1/feedback/admin/access', { preHandler: app.authenticate },
        async (request) => ({ admin: isFeedbackAdmin(request.userId) }));
    app.get('/v1/feedback/admin', { preHandler: app.authenticate, schema: { querystring: FeedbackListQuerySchema } },
        async (request, reply) => handle(reply, () => listFeedback(request.userId, request.query)));
    app.post('/v1/feedback/admin/:id/read', { ...auth, schema: { params, body: FeedbackReadSchema } },
        async (request, reply) => handle(reply, () => markFeedbackRead(request.userId, request.params.id, request.body.read)));
}
