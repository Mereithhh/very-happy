import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ verify: async (_token: string): Promise<{ userId: string } | null> => null }));
vi.mock('@/app/auth/auth', () => ({ auth: { verifyToken: (token: string) => state.verify(token) } }));

import { enableAuthentication } from './enableAuthentication';

async function app() {
    const server = fastify();
    enableAuthentication(server as any);
    server.get('/v1/x', { preHandler: (server as any).authenticate }, async (request: any) => ({ userId: request.userId }));
    await server.ready();
    return server;
}

describe('authenticate decorator (B-825)', () => {
    it('an invalid or missing token is 401 — the only answer Web treats as signed out', async () => {
        const server = await app();
        state.verify = async () => null;
        expect((await server.inject({ url: '/v1/x', headers: { authorization: 'Bearer dead' } })).statusCode).toBe(401);
        expect((await server.inject({ url: '/v1/x' })).statusCode).toBe(401);
    });

    it('a token that cannot be checked (store down) is a retryable 503, never 401', async () => {
        const server = await app();
        state.verify = async () => { throw new Error('connection terminated'); };
        const res = await server.inject({ url: '/v1/x', headers: { authorization: 'Bearer valid' } });
        expect(res.statusCode).toBe(503);
        expect(res.headers['retry-after']).toBe('5');
        expect(res.json()).toEqual({ error: 'auth_unavailable' });
    });

    it('a valid token passes', async () => {
        const server = await app();
        state.verify = async () => ({ userId: 'u1' });
        const res = await server.inject({ url: '/v1/x', headers: { authorization: 'Bearer valid' } });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ userId: 'u1' });
    });
});
