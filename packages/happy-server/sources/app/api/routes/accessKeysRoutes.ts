import { Fastify } from "../types";
import { z } from "zod";
import { db } from "@/storage/db";
import { log } from "@/utils/log";
import {
    accessKeyCreateSchema,
    accessKeyIdSchema,
    accessKeyUpdateSchema,
    createAccessKeyWithQuota,
    updateAccessKeyWithQuota,
} from '@/app/accessKeys/accessKeyStore';
import { isAccountResourceLimitError } from '../resourceLimits';

export function accessKeysRoutes(app: Fastify) {
    // Get Access Key API
    app.get('/v1/access-keys/:sessionId/:machineId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: accessKeyIdSchema,
                machineId: accessKeyIdSchema
            }).strict(),
            response: {
                200: z.object({
                    accessKey: z.object({
                        data: z.string(),
                        dataVersion: z.number(),
                        createdAt: z.number(),
                        updatedAt: z.number()
                    }).nullable()
                }),
                404: z.object({
                    error: z.literal('Session or machine not found')
                }),
                500: z.object({
                    error: z.literal('Failed to get access key')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, machineId } = request.params;

        try {
            // Verify session and machine belong to user
            const [session, machine] = await Promise.all([
                db.session.findFirst({
                    where: { id: sessionId, accountId: userId }
                }),
                db.machine.findFirst({
                    where: { id: machineId, accountId: userId }
                })
            ]);

            if (!session || !machine) {
                return reply.code(404).send({ error: 'Session or machine not found' });
            }

            // Get access key
            const accessKey = await db.accessKey.findUnique({
                where: {
                    accountId_machineId_sessionId: {
                        accountId: userId,
                        machineId,
                        sessionId
                    }
                }
            });

            if (!accessKey) {
                return reply.send({ accessKey: null });
            }

            return reply.send({
                accessKey: {
                    data: accessKey.data,
                    dataVersion: accessKey.dataVersion,
                    createdAt: accessKey.createdAt.getTime(),
                    updatedAt: accessKey.updatedAt.getTime()
                }
            });
        } catch (error) {
            log({ module: 'api', level: 'error', error }, 'Failed to get access key');
            return reply.code(500).send({ error: 'Failed to get access key' });
        }
    });

    // Create Access Key API
    app.post('/v1/access-keys/:sessionId/:machineId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: accessKeyIdSchema,
                machineId: accessKeyIdSchema
            }).strict(),
            body: accessKeyCreateSchema,
            response: {
                200: z.object({
                    success: z.boolean(),
                    accessKey: z.object({
                        data: z.string(),
                        dataVersion: z.number(),
                        createdAt: z.number(),
                        updatedAt: z.number()
                    }).optional(),
                    error: z.string().optional()
                }),
                404: z.object({
                    error: z.literal('Session or machine not found')
                }),
                409: z.object({
                    error: z.literal('Access key already exists')
                }),
                413: z.object({ error: z.literal('access_key_bytes_quota_exceeded') }),
                429: z.object({ error: z.enum(['access_key_count_quota_exceeded', 'access_key_rate_quota_exceeded']) }),
                500: z.object({
                    error: z.literal('Failed to create access key')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, machineId } = request.params;
        const { data } = request.body;

        try {
            const result = await createAccessKeyWithQuota({ accountId: userId, sessionId, machineId, data });
            if (result.kind === 'owner-not-found') {
                return reply.code(404).send({ error: 'Session or machine not found' });
            }
            if (result.kind === 'conflict') {
                return reply.code(409).send({ error: 'Access key already exists' });
            }
            const { accessKey } = result;

            log({ module: 'access-keys', userId, sessionId, machineId, created: result.created }, 'Access key create completed');

            return reply.send({
                success: true,
                accessKey: {
                    data: accessKey.data,
                    dataVersion: accessKey.dataVersion,
                    createdAt: accessKey.createdAt.getTime(),
                    updatedAt: accessKey.updatedAt.getTime()
                }
            });
        } catch (error) {
            if (isAccountResourceLimitError(error)) {
                return reply.code(error.statusCode).send({ error: error.code as any });
            }
            log({ module: 'api', level: 'error', error }, 'Failed to create access key');
            return reply.code(500).send({ error: 'Failed to create access key' });
        }
    });

    // Update Access Key API
    app.put('/v1/access-keys/:sessionId/:machineId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: accessKeyIdSchema,
                machineId: accessKeyIdSchema
            }).strict(),
            body: accessKeyUpdateSchema,
            response: {
                200: z.union([
                    z.object({
                        success: z.literal(true),
                        version: z.number()
                    }),
                    z.object({
                        success: z.literal(false),
                        error: z.literal('version-mismatch'),
                        currentVersion: z.number(),
                        currentData: z.string()
                    })
                ]),
                404: z.object({
                    error: z.literal('Access key not found')
                }),
                413: z.object({
                    success: z.literal(false),
                    error: z.literal('access_key_bytes_quota_exceeded')
                }),
                429: z.object({
                    success: z.literal(false),
                    error: z.literal('access_key_rate_quota_exceeded')
                }),
                500: z.object({
                    success: z.literal(false),
                    error: z.literal('Failed to update access key')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, machineId } = request.params;
        const { data, expectedVersion } = request.body;

        try {
            const result = await updateAccessKeyWithQuota({
                accountId: userId,
                sessionId,
                machineId,
                data,
                expectedVersion,
            });
            if (result.kind === 'not-found') {
                return reply.code(404).send({ error: 'Access key not found' });
            }
            if (result.kind === 'version-mismatch') {
                return reply.code(200).send({
                    success: false,
                    error: 'version-mismatch',
                    currentVersion: result.accessKey.dataVersion,
                    currentData: result.accessKey.data
                });
            }

            log({ module: 'access-keys', userId, sessionId, machineId }, `Updated access key to version ${expectedVersion + 1}`);

            return reply.send({
                success: true,
                version: expectedVersion + 1
            });
        } catch (error) {
            if (isAccountResourceLimitError(error)) {
                return reply.code(error.statusCode).send({ success: false, error: error.code as any });
            }
            log({ module: 'api', level: 'error', error }, 'Failed to update access key');
            return reply.code(500).send({
                success: false,
                error: 'Failed to update access key'
            });
        }
    });
}
