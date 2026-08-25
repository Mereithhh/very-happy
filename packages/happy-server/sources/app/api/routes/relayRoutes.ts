import { z } from 'zod';
import { db } from '@/storage/db';
import { Fastify } from '../types';
import { RELAY_ASSIGNMENT_TTL_MS, relayFeatureConfig } from '@/app/relay/relayConfig';
import { relayRegistry } from '@/app/relay/relayRegistry';
import { signRelayToken } from '@/app/relay/relayToken';
import { ServerRelayClaimRequestSchema } from '@/app/relay/relaySchemas';

async function ownsMachine(accountId: string, machineId: string): Promise<boolean> {
    return !!await db.machine.findFirst({ where: { id: machineId, accountId }, select: { id: true } });
}

export function relayRoutes(app: Fastify) {
    app.get('/v1/relays', { preHandler: app.authenticate }, async (_request, reply) => {
        const config = relayFeatureConfig();
        return reply.send({
            enabled: config.enabled,
            candidates: config.enabled ? config.candidates : [],
            assignmentTtlMs: RELAY_ASSIGNMENT_TTL_MS,
        });
    });

    app.post('/v1/relays/machines/:machineId/claim', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ machineId: z.string().min(1).max(256) }),
            body: ServerRelayClaimRequestSchema,
        },
    }, async (request, reply) => {
        const config = relayFeatureConfig();
        if (!config.enabled || !config.tokenSecret) return reply.code(404).send({ error: 'relay_not_configured' });
        const { machineId } = request.params as { machineId: string };
        if (!await ownsMachine(request.userId, machineId)) return reply.code(404).send({ error: 'machine_not_found' });
        const candidate = config.candidates.find((item) => item.id === request.body.relayId);
        if (!candidate) return reply.code(400).send({ error: 'unknown_relay' });
        relayRegistry.claim({
            accountId: request.userId,
            machineId,
            relayId: candidate.id,
            probes: request.body.probes,
        });
        const signed = signRelayToken({
            secret: config.tokenSecret,
            accountId: request.userId,
            relayId: candidate.id,
            machineId,
            clientType: 'machine',
        });
        return reply.send({ assignment: { ...candidate, ...signed } });
    });

    app.get('/v1/relays/machines/:machineId', {
        preHandler: app.authenticate,
        schema: { params: z.object({ machineId: z.string().min(1).max(256) }) },
    }, async (request, reply) => {
        const config = relayFeatureConfig();
        if (!config.enabled || !config.tokenSecret) return reply.send({ assignment: null });
        const { machineId } = request.params as { machineId: string };
        if (!await ownsMachine(request.userId, machineId)) return reply.code(404).send({ error: 'machine_not_found' });
        const lease = relayRegistry.get(request.userId, machineId);
        if (!lease) return reply.send({ assignment: null });
        const candidate = config.candidates.find((item) => item.id === lease.relayId);
        if (!candidate) {
            relayRegistry.remove(machineId);
            return reply.send({ assignment: null });
        }
        const signed = signRelayToken({
            secret: config.tokenSecret,
            accountId: request.userId,
            relayId: candidate.id,
            machineId,
            clientType: 'web',
        });
        return reply.send({ assignment: { ...candidate, ...signed } });
    });
}
