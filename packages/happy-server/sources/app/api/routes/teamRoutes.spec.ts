import { describe, it, expect, vi } from 'vitest';

const actOnTeam = vi.fn();
vi.mock('@/app/teams/store', () => ({ createTeam: vi.fn(), listTeams: vi.fn(), readTeam: vi.fn(), actOnTeam: (...args: unknown[]) => actOnTeam(...args), tickTeamSchedules: vi.fn() }));
vi.mock('@/app/projects/store', () => ({ bindTeamProject: vi.fn() }));

/** B-912: a team 429 tells the client when to retry; the CLI team_* tools back off on it. */
describe('team routes: retry-after on 429', () => {
    const app = async () => {
        const { default: fastify } = await import('fastify');
        const { serializerCompiler, validatorCompiler } = await import('fastify-type-provider-zod');
        const { teamRoutes } = await import('./teamRoutes');
        const server = fastify(); server.setValidatorCompiler(validatorCompiler); server.setSerializerCompiler(serializerCompiler);
        server.decorate('authenticate', async (request: any) => { request.userId = 'account'; });
        teamRoutes(server as any);
        return server;
    };
    const post = (server: Awaited<ReturnType<typeof app>>) => server.inject({ method: 'POST', url: '/v1/teams/t/agent', headers: { 'x-happy-team-token': 'tok' }, payload: { requestId: 'r', action: { type: 'message', taskId: 'x', body: 'b' } } });

    it('sets retry-after on a 429 (given seconds, else the default) and never on other refusals', async () => {
        const { TeamError } = await import('@/app/teams/errors');
        const { ProjectError } = await import('@/app/projects/rules');
        const { TEAM_DEFAULT_RETRY_AFTER_SECONDS } = await import('./teamRoutes');
        const server = await app();
        try {
            actOnTeam.mockRejectedValueOnce(new TeamError('team_rate_limited', 429));
            const plain = await post(server);
            expect(plain.statusCode).toBe(429);
            expect(plain.headers['retry-after']).toBe(String(TEAM_DEFAULT_RETRY_AFTER_SECONDS));
            expect(plain.json()).toEqual({ error: 'team_rate_limited' });
            actOnTeam.mockRejectedValueOnce(new TeamError('team_rate_limited', 429, { retryAfter: 12.2 }));
            expect((await post(server)).headers['retry-after']).toBe('13');
            actOnTeam.mockRejectedValueOnce(new ProjectError('message_quota_exceeded', 429, { limit: 5 }));
            expect((await post(server)).headers['retry-after']).toBe(String(TEAM_DEFAULT_RETRY_AFTER_SECONDS));
            actOnTeam.mockRejectedValueOnce(new TeamError('recipient_outside_task', 403, { ownerBotId: 'lead' }));
            const refused = await post(server);
            expect(refused.statusCode).toBe(403);
            expect(refused.headers['retry-after']).toBeUndefined();
            expect(refused.json()).toEqual({ error: 'recipient_outside_task', ownerBotId: 'lead' });
        } finally { await server.close(); }
    });
});
