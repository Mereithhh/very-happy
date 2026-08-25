import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { relayRoutes } from './relayRoutes';
import { verifyRelayToken } from '@/app/relay/relayToken';

const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock('@/storage/db', () => ({ db: { machine: { findFirst } } }));

describe('relay routes', () => {
    const previousCandidates = process.env.HAPPY_RELAYS_JSON;
    const previousSecret = process.env.RELAY_TOKEN_SECRET;

    beforeEach(() => {
        findFirst.mockReset();
        process.env.HAPPY_RELAYS_JSON = JSON.stringify([{ id: 'sin', url: 'https://sin.example.com', region: 'Singapore' }]);
        process.env.RELAY_TOKEN_SECRET = 'route-test-secret-at-least-32-bytes';
    });
    afterEach(() => {
        if (previousCandidates === undefined) delete process.env.HAPPY_RELAYS_JSON;
        else process.env.HAPPY_RELAYS_JSON = previousCandidates;
        if (previousSecret === undefined) delete process.env.RELAY_TOKEN_SECRET;
        else process.env.RELAY_TOKEN_SECRET = previousSecret;
    });

    async function makeApp() {
        const app = fastify();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const typed = app.withTypeProvider<ZodTypeProvider>() as any;
        typed.decorate('authenticate', async (request: any) => { request.userId = 'a1'; });
        relayRoutes(typed);
        await app.ready();
        return app;
    }

    it('requires machine ownership before minting a scoped token', async () => {
        findFirst.mockResolvedValue(null);
        const app = await makeApp();
        const response = await app.inject({
            method: 'POST', url: '/v1/relays/machines/m1/claim',
            payload: { relayId: 'sin', probes: [{ relayId: 'sin', rttMs: 12 }] },
        });
        expect(response.statusCode).toBe(404);
        await app.close();
    });

    it('returns machine and web tokens bound to the selected relay', async () => {
        findFirst.mockResolvedValue({ id: 'm1' });
        const app = await makeApp();
        const claim = await app.inject({
            method: 'POST', url: '/v1/relays/machines/m1/claim',
            payload: { relayId: 'sin', probes: [{ relayId: 'sin', rttMs: 12 }] },
        });
        expect(claim.statusCode).toBe(200);
        expect(verifyRelayToken({ token: claim.json().assignment.token, secret: 'route-test-secret-at-least-32-bytes', relayId: 'sin' })?.clientType).toBe('machine');
        const assignment = await app.inject({ method: 'GET', url: '/v1/relays/machines/m1' });
        expect(assignment.statusCode).toBe(200);
        expect(verifyRelayToken({ token: assignment.json().assignment.token, secret: 'route-test-secret-at-least-32-bytes', relayId: 'sin' })?.clientType).toBe('web');
        await app.close();
    });
});
