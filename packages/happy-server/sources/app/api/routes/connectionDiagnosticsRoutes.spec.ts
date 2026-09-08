import fastify from 'fastify';
import { validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionDiagnosticsRoutes } from './connectionDiagnosticsRoutes';
import { sanitizeLogValue } from '@/utils/logSafety';
const { findMany, allow, log } = vi.hoisted(() => ({ findMany: vi.fn(), allow: vi.fn(), log: vi.fn() }));
vi.mock('@/storage/db', () => ({ db: { machine: { findMany } } }));
vi.mock('@/app/auth/authRateLimiter', () => ({ allowAuthRequest: allow }));
vi.mock('@/utils/log', () => ({ log }));
const event = {
    attemptId: 'db48f13c-29f5-49f3-8f45-5e6bc59caeaa', machineId: 'machine-1',
    at: 1000, stage: 'terminal_open', outcome: 'timeout', durationMs: 3000,
    deviceClass: 'mobile', visibility: 'visible', client: 'web/78086a260',
};
async function makeApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.decorate('authenticate', async (request: any, reply: any) => {
        if (request.headers.authorization !== 'Bearer test') return reply.code(401).send({ error: 'unauthorized' });
        request.userId = 'account-1';
    });
    connectionDiagnosticsRoutes(app as any);
    await app.ready();
    return app;
}
async function post(events: unknown[], options: { auth?: boolean; extra?: object } = {}) {
    const app = await makeApp();
    try { return await app.inject({ method: 'POST', url: '/v1/diagnostics/connections',
        headers: options.auth === false ? {} : { authorization: 'Bearer test' },
        payload: { events, ...options.extra },
    }); } finally { await app.close(); }
}
beforeEach(() => { vi.clearAllMocks(); allow.mockResolvedValue(true); findMany.mockResolvedValue([{ id: 'machine-1' }]); });
describe('connection diagnostics route', () => {
    it('requires authentication before rate limiting or reading ownership', async () => {
        expect((await post([event], { auth: false })).statusCode).toBe(401);
        expect(allow).not.toHaveBeenCalled(); expect(findMany).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
    });
    it('checks distinct machines once and charges per event', async () => {
        const response = await post([event, event]);
        expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ accepted: 2 });
        expect(allow).toHaveBeenCalledWith('connection-diagnostics:account-1', { max: 120, windowMs: 60000, cost: 2 });
        expect(findMany).toHaveBeenCalledOnce();
        expect(findMany).toHaveBeenCalledWith({ where: { accountId: 'account-1', id: { in: ['machine-1'] } }, select: { id: true } });
        const sanitized = sanitizeLogValue(log.mock.calls[0][0]) as any;
        expect(sanitized).toMatchObject({ operation: 'terminal_open', status: 'timeout', platform: 'mobile', mode: 'visible', client: 'web/78086a260', durationMs: 3000 });
        expect(sanitized.tag).toMatch(/^tag:[a-f0-9]{16}$/);
        expect(JSON.stringify(sanitized)).not.toContain(event.attemptId);
        expect(JSON.stringify(sanitized)).not.toContain('account-1');
        expect(JSON.stringify(sanitized)).not.toContain('machine-1');
    });
    it('rejects the entire batch when any machine is not owned', async () => {
        expect((await post([event, { ...event, machineId: 'other' }])).statusCode).toBe(422);
        expect(log).not.toHaveBeenCalled();
    });
    it('rate limits before ownership queries and logging', async () => {
        allow.mockResolvedValue(false);
        expect((await post([event])).statusCode).toBe(429);
        expect(findMany).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
    });
    it('accepts control failures without a target machine', async () => {
        expect((await post([{ ...event, machineId: undefined, stage: 'control' }])).statusCode).toBe(200);
        expect(findMany).not.toHaveBeenCalled();
    });
    it('rejects content, large event arrays and large HTTP bodies', async () => {
        expect((await post([{ ...event, message: 'secret' }])).statusCode).toBe(400);
        expect((await post(Array(33).fill(event))).statusCode).toBe(400);
        expect((await post([event], { extra: { content: 'x'.repeat(25000) } })).statusCode).toBe(413);
        expect(log).not.toHaveBeenCalled();
    });
});
