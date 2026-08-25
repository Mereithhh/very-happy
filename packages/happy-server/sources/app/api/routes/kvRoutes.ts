import { z } from "zod";
import { Fastify } from "../types";
import { kvGet } from "@/app/kv/kvGet";
import { kvList } from "@/app/kv/kvList";
import { kvBulkGet } from "@/app/kv/kvBulkGet";
import { kvKeySchema, kvMutate, kvMutationsBodySchema, KV_KEY_MAX_BYTES } from "@/app/kv/kvMutate";
import { log } from "@/utils/log";
import { isAccountResourceLimitError } from '../resourceLimits';
import { utf8StringSchema } from '../resourceSchemas';

export function kvRoutes(app: Fastify) {
    // GET /v1/kv/:key - Get single value
    app.get('/v1/kv/:key', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                key: kvKeySchema
            }),
            response: {
                200: z.object({
                    key: z.string(),
                    value: z.string(),
                    version: z.number()
                }).nullable(),
                404: z.object({
                    error: z.literal('Key not found')
                }),
                500: z.object({
                    error: z.literal('Failed to get value')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { key } = request.params;

        try {
            const result = await kvGet({ uid: userId }, key);

            if (!result) {
                return reply.code(404).send({ error: 'Key not found' });
            }

            return reply.send(result);
        } catch (error) {
            log({ module: 'api', level: 'error', error }, 'Failed to get KV value');
            return reply.code(500).send({ error: 'Failed to get value' });
        }
    });

    // GET /v1/kv - List key-value pairs with optional prefix filter
    app.get('/v1/kv', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                prefix: utf8StringSchema({ maxBytes: KV_KEY_MAX_BYTES }).optional(),
                limit: z.coerce.number().int().min(1).max(1000).default(100)
            }),
            response: {
                200: z.object({
                    items: z.array(z.object({
                        key: z.string(),
                        value: z.string(),
                        version: z.number()
                    }))
                }),
                500: z.object({
                    error: z.literal('Failed to list items')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { prefix, limit } = request.query;

        try {
            const result = await kvList({ uid: userId }, { prefix, limit });
            return reply.send(result);
        } catch (error) {
            log({ module: 'api', level: 'error', error }, 'Failed to list KV items');
            return reply.code(500).send({ error: 'Failed to list items' });
        }
    });

    // POST /v1/kv/bulk - Bulk get values
    app.post('/v1/kv/bulk', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                keys: z.array(kvKeySchema).min(1).max(100)
            }),
            response: {
                200: z.object({
                    values: z.array(z.object({
                        key: z.string(),
                        value: z.string(),
                        version: z.number()
                    }))
                }),
                500: z.object({
                    error: z.literal('Failed to get values')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { keys } = request.body;

        try {
            const result = await kvBulkGet({ uid: userId }, keys);
            return reply.send(result);
        } catch (error) {
            log({ module: 'api', level: 'error', error }, 'Failed to bulk get KV values');
            return reply.code(500).send({ error: 'Failed to get values' });
        }
    });

    // PUT /v1/kv - Atomic batch mutation
    app.post('/v1/kv', {
        preHandler: app.authenticate,
        schema: {
            body: kvMutationsBodySchema,
            response: {
                200: z.object({
                    success: z.literal(true),
                    results: z.array(z.object({
                        key: z.string(),
                        version: z.number()
                    }))
                }),
                409: z.object({
                    success: z.literal(false),
                    errors: z.array(z.object({
                        key: z.string(),
                        error: z.literal('version-mismatch'),
                        version: z.number(),
                        value: z.string().nullable()
                    }))
                }),
                413: z.object({ error: z.literal('kv_bytes_quota_exceeded') }),
                429: z.object({ error: z.enum(['kv_count_quota_exceeded', 'kv_rate_quota_exceeded']) }),
                500: z.object({
                    error: z.literal('Failed to mutate values')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { mutations } = request.body;

        try {
            const result = await kvMutate({ uid: userId }, mutations);

            if (!result.success) {
                return reply.code(409).send({
                    success: false as const,
                    errors: result.errors!
                });
            }

            return reply.send({
                success: true as const,
                results: result.results!
            });
        } catch (error) {
            if (isAccountResourceLimitError(error)) {
                return reply.code(error.statusCode).send({ error: error.code as any });
            }
            log({ module: 'api', level: 'error', error }, 'Failed to mutate KV values');
            return reply.code(500).send({ error: 'Failed to mutate values' });
        }
    });
}
