import { ConnectionDiagnosticBatchSchema } from '@slopus/happy-wire';
import { allowAuthRequest } from '@/app/auth/authRateLimiter';
import { db } from '@/storage/db';
import { log } from '@/utils/log';
import { Fastify } from '../types';

export function connectionDiagnosticsRoutes(app: Fastify) {
    app.post('/v1/diagnostics/connections', {
        preHandler: app.authenticate,
        bodyLimit: 24 * 1024,
        schema: { body: ConnectionDiagnosticBatchSchema },
    }, async (request, reply) => {
        const { events } = request.body;
        // Shared limiter uses the existing durable account rate-limit store.
        // Charge events, not batches, before doing the ownership lookup.
        const allowed = await allowAuthRequest(`connection-diagnostics:${request.userId}`, {
            max: 120, windowMs: 60_000, cost: events.length,
        });
        if (!allowed) return reply.code(429).send({ error: 'diagnostics_rate_limited' });
        const machineIds = [...new Set(events.flatMap((event) => event.machineId ? [event.machineId] : []))];
        if (machineIds.length) {
            const owned = await db.machine.findMany({
                where: { accountId: request.userId, id: { in: machineIds } },
                select: { id: true },
            });
            if (owned.length !== machineIds.length) return reply.code(422).send({ error: 'diagnostics_target_unavailable' });
        }
        for (const event of events) {
            // Existing logSafety hashes userId/machineId/tag and preserves these
            // categorical keys. `at` is client-reported; the logger adds receipt time.
            log({
                module: 'connection-diagnostics', event: 'browser-connection',
                userId: request.userId, machineId: event.machineId, tag: event.attemptId,
                operation: event.stage, status: event.outcome, durationMs: event.durationMs,
                platform: event.deviceClass, mode: event.visibility, client: event.client,
                at: event.at,
            });
        }
        return reply.send({ accepted: events.length });
    });
}
