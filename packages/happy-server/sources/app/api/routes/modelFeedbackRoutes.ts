import { z } from 'zod';
import { INSTANCE_CONFIG_PATH, ModelFeedbackRatingSchema, ModelFeedbackSubmitSchema } from '@slopus/happy-wire';
import type { Fastify } from '@/app/api/types';
import { isAccountResourceLimitError } from '@/app/api/resourceLimits';
import { clientInstanceConfig, instanceConfig } from '@/app/instance/instanceConfig';
import {
    deleteModelFeedback, exportModelFeedback, isModelFeedbackAdmin, listSessionModelFeedback, ModelFeedbackError, modelFeedbackCsv,
    submitModelFeedback,
} from '@/app/modelFeedback/modelFeedbackStore';

const BODY_LIMIT = 32 * 1024;
const Id = z.string().min(1).max(128);

const ExportQuerySchema = z.object({
    format: z.enum(['jsonl', 'csv', 'json']).default('jsonl'),
    since: z.coerce.number().int().nonnegative().optional(),
    until: z.coerce.number().int().nonnegative().optional(),
    model: z.string().max(200).optional(),
    rating: ModelFeedbackRatingSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50_000).default(10_000),
});

/**
 * B-980 model-answer feedback (`specs/2026-11-model-feedback.md`).
 * `GET /v1/instance/config` tells every signed-in client (Web and CLI) what
 * the operator turned on; it never carries forward targets or credentials.
 * Feedback routes answer 404 `model_feedback_disabled` while the feature is off.
 */
export function modelFeedbackRoutes(app: Fastify) {
    const handle = async (reply: any, work: () => Promise<unknown>) => {
        try {
            return await work();
        } catch (error) {
            if (error instanceof ModelFeedbackError) return reply.code(error.status).send({ error: error.code });
            if (isAccountResourceLimitError(error)) return reply.code(error.statusCode).send({ error: 'model_feedback_rate_limited' });
            throw error;
        }
    };

    app.get(INSTANCE_CONFIG_PATH, { preHandler: app.authenticate }, async (request) => ({
        ...clientInstanceConfig(instanceConfig()),
        modelFeedbackAdmin: isModelFeedbackAdmin(request.userId),
    }));

    app.put('/v1/model-feedback', { preHandler: app.authenticate, bodyLimit: BODY_LIMIT, schema: { body: ModelFeedbackSubmitSchema } },
        async (request, reply) => handle(reply, () => submitModelFeedback(request.userId, request.body)));

    app.delete('/v1/model-feedback', { preHandler: app.authenticate, schema: { querystring: z.object({ sessionId: Id, turnId: Id }) } },
        async (request, reply) => handle(reply, () => deleteModelFeedback(request.userId, request.query.sessionId, request.query.turnId)));

    app.get('/v1/model-feedback', { preHandler: app.authenticate, schema: { querystring: z.object({ sessionId: Id }) } },
        async (request, reply) => handle(reply, () => listSessionModelFeedback(request.userId, request.query.sessionId)));

    // Admin export. Works with any token of an admin account, so `curl -H "Authorization: Bearer …"` scripts it.
    app.get('/v1/model-feedback/export', { preHandler: app.authenticate, schema: { querystring: ExportQuerySchema } },
        async (request, reply) => handle(reply, async () => {
            const { format, ...query } = request.query;
            const records = await exportModelFeedback(request.userId, query);
            const stamp = new Date().toISOString().slice(0, 10);
            if (format === 'json') return { items: records };
            reply.header('cache-control', 'no-store');
            if (format === 'csv') {
                reply.header('content-type', 'text/csv; charset=utf-8');
                reply.header('content-disposition', `attachment; filename="model-feedback-${stamp}.csv"`);
                return reply.send(modelFeedbackCsv(records));
            }
            reply.header('content-type', 'application/x-ndjson; charset=utf-8');
            reply.header('content-disposition', `attachment; filename="model-feedback-${stamp}.jsonl"`);
            return reply.send(records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
        }));
}
