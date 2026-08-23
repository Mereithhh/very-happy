import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { Fastify } from '../types';
import { allowAuthRequest } from '@/app/auth/authRateLimiter';

const MIN_REMOTE_LOG_TOKEN_BYTES = 32;

export function remoteLogTokenMatches(authorization: unknown, expectedToken: string | undefined): boolean {
    if (typeof authorization !== 'string' || !expectedToken || Buffer.byteLength(expectedToken) < MIN_REMOTE_LOG_TOKEN_BYTES) return false;
    const prefix = 'Bearer ';
    if (!authorization.startsWith(prefix)) return false;
    const actual = Buffer.from(authorization.slice(prefix.length));
    const expected = Buffer.from(expectedToken);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function devRoutes(app: Fastify) {

    // Combined logging endpoint (only when explicitly enabled)
    const remoteLogToken = process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING_TOKEN;
    if (process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING && remoteLogToken && Buffer.byteLength(remoteLogToken) < MIN_REMOTE_LOG_TOKEN_BYTES) {
        throw new Error(`Remote debugging token must contain at least ${MIN_REMOTE_LOG_TOKEN_BYTES} bytes`);
    }
    if (process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING && remoteLogToken) {
        app.post('/logs-combined-from-cli-and-mobile-for-simple-ai-debugging', {
            preHandler: async (request, reply) => {
                if (!remoteLogTokenMatches(request.headers.authorization, remoteLogToken)) {
                    return reply.code(401).send({ error: 'Unauthorized' });
                }
                if (!(await allowAuthRequest(`remote-log:${request.ip}`, { max: 60, windowMs: 60_000 }))) {
                    return reply.code(429).send({ error: 'Too many requests' });
                }
            },
            schema: {
                body: z.object({
                    timestamp: z.string().max(128),
                    level: z.string().max(32),
                    message: z.string().max(64 * 1024),
                    messageRawObject: z.any().optional(),
                    source: z.enum(['mobile', 'cli']),
                    platform: z.string().max(128).optional()
                })
            }
        }, async (request, reply) => {
            const { timestamp, level, message, source, platform } = request.body;

            // Log ONLY to separate remote logger (file only, no console)
            const logData = {
                source,
                platform,
                timestamp
            };

            // Use the file-only logger if available
            const { fileConsolidatedLogger } = await import('@/utils/log');

            if (!fileConsolidatedLogger) {
                // Should never happen since we check env var above, but be safe
                return reply.send({ success: true });
            }

            switch (level.toLowerCase()) {
                case 'error':
                    fileConsolidatedLogger.error(logData, message);
                    break;
                case 'warn':
                case 'warning':
                    fileConsolidatedLogger.warn(logData, message);
                    break;
                case 'debug':
                    fileConsolidatedLogger.debug(logData, message);
                    break;
                default:
                    fileConsolidatedLogger.info(logData, message);
            }

            return reply.send({ success: true });
        });
    }
}
