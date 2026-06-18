import { z } from "zod";
import { Fastify } from "../types";
import { FeedBodySchema } from "@/app/feed/types";
import { feedGet } from "@/app/feed/feedGet";
import { feedPost } from "@/app/feed/feedPost";
import { Context } from "@/context";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { log } from "@/utils/log";

export function feedRoutes(app: Fastify) {
    app.get('/v1/feed', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                before: z.string().optional(),
                after: z.string().optional(),
                limit: z.coerce.number().int().min(1).max(200).default(50)
            }).optional(),
            response: {
                200: z.object({
                    items: z.array(z.object({
                        id: z.string(),
                        body: FeedBodySchema,
                        repeatKey: z.string().nullable(),
                        cursor: z.string(),
                        createdAt: z.number()
                    })),
                    hasMore: z.boolean()
                })
            }
        }
    }, async (request, reply) => {
        const items = await feedGet(db, Context.create(request.userId), {
            cursor: {
                before: request.query?.before,
                after: request.query?.after
            },
            limit: request.query?.limit
        });
        return reply.send({ items: items.items, hasMore: items.hasMore });
    });

    // POST /v1/feed — append a notification to the caller's feed.
    // Reuses feedPost (counter allocation, repeatKey dedup, socket broadcast).
    app.post('/v1/feed', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                notifType: z.enum(['permission_request', 'reply_done', 'input_needed', 'error']),
                sessionId: z.string(),
                enc: z.string(),
                repeatKey: z.string().nullish()
            }),
            response: {
                200: z.object({
                    id: z.string(),
                    body: FeedBodySchema,
                    repeatKey: z.string().nullable(),
                    cursor: z.string(),
                    createdAt: z.number()
                }),
                500: z.object({ error: z.literal('Failed to post feed item') })
            }
        }
    }, async (request, reply) => {
        const { notifType, sessionId, enc, repeatKey } = request.body;
        try {
            const item = await inTx(async (tx) => {
                return await feedPost(
                    tx,
                    Context.create(request.userId),
                    { kind: 'notification', notifType, sessionId, enc },
                    repeatKey ?? null
                );
            });
            return reply.send({
                id: item.id,
                body: item.body,
                repeatKey: item.repeatKey,
                cursor: item.cursor,
                createdAt: item.createdAt
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to post feed item: ${error}`);
            return reply.code(500).send({ error: 'Failed to post feed item' as const });
        }
    });
}