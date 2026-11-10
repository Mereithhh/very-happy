import { teamPollOperations } from '@/app/teams/poll';
import { z } from 'zod';
import { TeamActionRequestSchema, TeamCreateSchema, TeamProjectBindSchema } from '@slopus/happy-wire';
import { bindTeamProject } from '@/app/projects/store';
import { ProjectError } from '@/app/projects/rules';
import type { Fastify } from '../types';
import { createTeam, listTeams, readTeam, actOnTeam, tickTeamSchedules } from '@/app/teams/store';
import { TeamError } from '@/app/teams/reducer';
import { teamActionReceipt } from '@/app/teams/receipt';

const params = z.object({ id: z.string().min(1).max(128) });
/** B-912: seconds a client should wait before retrying a team 429 (CLI team_* tools back off on it). */
export const TEAM_DEFAULT_RETRY_AFTER_SECONDS = 5;
export function teamRetryAfterSeconds(status: number, details?: Record<string, unknown>): number | null {
    if (status !== 429) return null;
    const given = details?.retryAfter;
    return typeof given === 'number' && Number.isFinite(given) && given > 0 ? Math.min(3600, Math.ceil(given)) : TEAM_DEFAULT_RETRY_AFTER_SECONDS;
}
export function teamRoutes(app: Fastify) {
    const handle = async (reply: any, work: () => Promise<unknown>) => {
        try { return await work(); }
        catch (error) {
            // B-726: project errors raised while creating/binding a team keep their own codes.
            if (error instanceof TeamError || error instanceof ProjectError) {
                const retryAfter = teamRetryAfterSeconds(error.status, error.details);
                if (retryAfter !== null) reply.header('retry-after', String(retryAfter));
                return reply.code(error.status).send({ error: error.code, ...(error.details ?? {}) });
            }
            throw error;
        }
    };
    app.get('/v1/teams', { preHandler: app.authenticate }, async (request, reply) => handle(reply, async () => ({ teams: await listTeams(request.userId) })));
    app.post('/v1/teams', { preHandler: app.authenticate, schema: { body: TeamCreateSchema } }, async (request, reply) => handle(reply, async () => ({ team: await createTeam(request.userId, request.body) })));
    app.post('/v1/teams/schedules/tick', { preHandler: app.authenticate, schema: { body: z.object({ machineId: z.string().min(1).max(128) }) } }, async (request, reply) => handle(reply, () => tickTeamSchedules(request.userId, request.body.machineId)));
    app.get('/v1/teams/operations', { preHandler: app.authenticate, schema: { querystring: z.object({ machineId: z.string().min(1).max(128), schedulesVersion: z.coerce.number().int().min(1).max(1).optional(), teamLaunchVersion: z.coerce.number().int().min(1).max(1).optional(), teamArchiveVersion: z.coerce.number().int().min(1).max(1).optional() }) } }, async (request, reply) => handle(reply, async () => {
        const allTeams = await listTeams(request.userId, request.query.machineId);
        const teams = request.query.schedulesVersion === 1 ? allTeams : allTeams.map(team => ({ ...team, messages: team.messages.filter(message => !message.scheduleId) }));
        return { teams, operations: teamPollOperations(teams, request.query) };
    }));
    app.get('/v1/teams/:id', { preHandler: app.authenticate, schema: { params } }, async (request, reply) => handle(reply, async () => ({ team: await readTeam(request.params.id, { accountId: request.userId }) })));
    // B-726: owner-only team ↔ project binding (team settings, old-team one-click).
    app.post('/v1/teams/:id/project', { preHandler: app.authenticate, schema: { params, body: TeamProjectBindSchema } }, async (request, reply) => handle(reply, () => bindTeamProject(request.userId, request.params.id, request.body)));
    app.post('/v1/teams/:id/actions', { preHandler: app.authenticate, schema: { params, body: TeamActionRequestSchema } }, async (request, reply) => handle(reply, () => actOnTeam(request.params.id, { accountId: request.userId }, request.body)));
    const scope = (request: { headers: Record<string, unknown> }) => {
        const token = request.headers['x-happy-team-token'];
        if (typeof token !== 'string' || token.length > 256) throw new TeamError('invalid_team_token', 401);
        return { token };
    };
    app.get('/v1/teams/:id/agent', { schema: { params } }, async (request, reply) => handle(reply, async () => ({ team: await readTeam(request.params.id, scope(request)) })));
    // B-911: scoped writes (the team_* tools of every wrapper, old ones forward this verbatim) answer a receipt, never the team.
    app.post('/v1/teams/:id/agent', { schema: { params, body: TeamActionRequestSchema } }, async (request, reply) => handle(reply, async () => teamActionReceipt(await actOnTeam(request.params.id, scope(request), request.body), request.body.action)));
}
