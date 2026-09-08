import { z } from 'zod';
import { TeamActionRequestSchema, TeamCreateSchema } from '@slopus/happy-wire';
import type { Fastify } from '../types';
import { createTeam, listTeams, readTeam, actOnTeam } from '@/app/teams/store';
import { TeamError } from '@/app/teams/reducer';

const params = z.object({ id: z.string().min(1).max(128) });
export function teamRoutes(app: Fastify) {
    const handle = async (reply: any, work: () => Promise<unknown>) => {
        try { return await work(); }
        catch (error) {
            if (error instanceof TeamError) return reply.code(error.status).send({ error: error.code });
            throw error;
        }
    };
    app.get('/v1/teams', { preHandler: app.authenticate }, async (request, reply) => handle(reply, async () => ({ teams: await listTeams(request.userId) })));
    app.post('/v1/teams', { preHandler: app.authenticate, schema: { body: TeamCreateSchema } }, async (request, reply) => handle(reply, async () => ({ team: await createTeam(request.userId, request.body) })));
    app.get('/v1/teams/operations', { preHandler: app.authenticate, schema: { querystring: z.object({ machineId: z.string().min(1).max(128) }) } }, async (request, reply) => handle(reply, async () => {
        const teams = await listTeams(request.userId, request.query.machineId);
        return { teams, operations: teams.flatMap(t => t.operations).filter(op => op.status === 'pending' || op.status === 'claimed' || op.status === 'unknown' || op.status === 'failed') };
    }));
    app.get('/v1/teams/:id', { preHandler: app.authenticate, schema: { params } }, async (request, reply) => handle(reply, async () => ({ team: await readTeam(request.params.id, { accountId: request.userId }) })));
    app.post('/v1/teams/:id/actions', { preHandler: app.authenticate, schema: { params, body: TeamActionRequestSchema } }, async (request, reply) => handle(reply, () => actOnTeam(request.params.id, { accountId: request.userId }, request.body)));
    const scope = (request: { headers: Record<string, unknown> }) => {
        const token = request.headers['x-happy-team-token'];
        if (typeof token !== 'string' || token.length > 256) throw new TeamError('invalid_team_token', 401);
        return { token };
    };
    app.get('/v1/teams/:id/agent', { schema: { params } }, async (request, reply) => handle(reply, async () => ({ team: await readTeam(request.params.id, scope(request)) })));
    app.post('/v1/teams/:id/agent', { schema: { params, body: TeamActionRequestSchema } }, async (request, reply) => handle(reply, () => actOnTeam(request.params.id, scope(request), request.body)));
}
