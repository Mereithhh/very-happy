import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fastify } from '../types';

const { state, storeMock, dbMock, authMock } = vi.hoisted(() => {
    const state = { row: null as any };
    class PairingCapacityError extends Error {
        constructor() {
            super('pairing-capacity');
            this.name = 'PairingCapacityError';
        }
    }
    const storeMock = {
        PAIRING_RESPONSE_MAX_BYTES: 4096,
        PairingCapacityError,
        findPairing: vi.fn(async () => state.row),
        createPairing: vi.fn(async (_kind: string, input: any) => {
            state.row = {
                id: 'request-1', publicKey: input.publicKey, supportsV2: input.supportsV2 ?? false,
                claimSecretHash: input.claimSecretHash, response: null, responseAccountId: null,
                createdAt: new Date(), updatedAt: new Date(),
            };
        }),
        deletePairing: vi.fn(async () => {
            await Promise.resolve();
            if (!state.row) return 0;
            state.row = null;
            return 1;
        }),
        approvePairingRow: vi.fn(async () => undefined),
    };
    const dbMock = {
        $queryRawUnsafe: vi.fn(async () => [{ count: 1 }]),
        $executeRawUnsafe: vi.fn(async () => 1),
        $transaction: vi.fn(async (fn: any) => fn(dbMock)),
        account: { findUnique: vi.fn(), update: vi.fn() },
    };
    const authMock = { createToken: vi.fn(async () => 'issued-token') };
    return { state, storeMock, dbMock, authMock };
});

vi.mock('@/app/auth/pairingStore', () => storeMock);
vi.mock('@/storage/db', () => ({ db: dbMock }));
vi.mock('@/app/auth/auth', () => ({ auth: authMock }));

import { authRoutes } from './authRoutes';
import { claimSecretHash } from '@/app/auth/pairingSecurity';

async function buildApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any) => { request.userId = 'account-1'; });
    authRoutes(typed);
    await app.ready();
    return app;
}

const publicKey = Buffer.alloc(32, 4).toString('base64url');
const claim = Buffer.alloc(32, 7).toString('base64url');

describe('claim-secret pairing routes', () => {
    beforeEach(() => {
        state.row = null;
        vi.clearAllMocks();
        delete process.env.AUTH_ALLOW_LEGACY_PAIRING;
        delete process.env.E2EE_SIGNUP_REQUIRED;
    });

    it('creates v3 requests and rejects a wrong claim', async () => {
        const app = await buildApp();
        const created = await app.inject({ method: 'POST', url: '/v1/auth/request', payload: {
            publicKey, claimSecret: claim, supportsClaimSecret: true, pairingAction: 'create', supportsV2: true,
        } });
        expect(created.statusCode).toBe(200);
        expect(created.json()).toMatchObject({ state: 'requested', protocolVersion: 3, claimSecretRequired: true });

        const wrong = await app.inject({ method: 'POST', url: '/v1/auth/request', payload: {
            publicKey, claimSecret: Buffer.alloc(32, 8).toString('base64url'), supportsClaimSecret: true, pairingAction: 'poll', supportsV2: true,
        } });
        expect(wrong.statusCode).toBe(403);
        expect(wrong.json()).toEqual({ error: 'invalid-claim' });
        await app.close();
    });

    it('rejects expired claims', async () => {
        state.row = {
            id: 'old', publicKey, supportsV2: true, claimSecretHash: claimSecretHash(claim),
            response: 'ciphertext', responseAccountId: 'account-1', createdAt: new Date(Date.now() - 11 * 60_000), updatedAt: new Date(),
        };
        const app = await buildApp();
        const response = await app.inject({ method: 'POST', url: '/v1/auth/request', payload: {
            publicKey, claimSecret: claim, supportsClaimSecret: true, pairingAction: 'poll', supportsV2: true,
        } });
        expect(response.statusCode).toBe(410);
        expect(response.json()).toEqual({ error: 'expired' });
        await app.close();
    });

    it('allows exactly one concurrent claim and rejects replay', async () => {
        state.row = {
            id: 'ready', publicKey, supportsV2: true, claimSecretHash: claimSecretHash(claim),
            response: 'ciphertext', responseAccountId: 'account-1', createdAt: new Date(), updatedAt: new Date(),
        };
        const app = await buildApp();
        const request = () => app.inject({ method: 'POST', url: '/v1/auth/request', payload: {
            publicKey, claimSecret: claim, supportsClaimSecret: true, pairingAction: 'poll', supportsV2: true,
        } });
        const concurrent = await Promise.all([request(), request()]);
        expect(concurrent.map((item) => item.statusCode).sort()).toEqual([200, 404]);
        expect(concurrent.find((item) => item.statusCode === 200)?.json()).toMatchObject({ state: 'authorized', token: 'issued-token' });

        const replay = await request();
        expect(replay.statusCode).toBe(404);
        expect(replay.json()).toEqual({ error: 'not-found' });
        await app.close();
    });

    it('rejects legacy pairing by default', async () => {
        const app = await buildApp();
        const response = await app.inject({ method: 'POST', url: '/v1/auth/request', payload: { publicKey, pairingAction: 'create', supportsV2: true } });
        expect(response.statusCode).toBe(426);
        expect(response.json()).toEqual({ error: 'upgrade-required' });
        await app.close();
    });

    it('returns a stable retryable error when the global pairing cap is full', async () => {
        storeMock.createPairing.mockRejectedValueOnce(new storeMock.PairingCapacityError());
        const app = await buildApp();
        const response = await app.inject({ method: 'POST', url: '/v1/auth/request', payload: {
            publicKey, claimSecret: claim, supportsClaimSecret: true, pairingAction: 'create', supportsV2: true,
        } });

        expect(response.statusCode).toBe(429);
        expect(response.json()).toEqual({ error: 'pairing-capacity' });
        await app.close();
    });

    it('rejects a multibyte approval response above the stored byte cap', async () => {
        state.row = {
            id: 'pending', publicKey, supportsV2: true, claimSecretHash: claimSecretHash(claim),
            response: null, responseAccountId: null, createdAt: new Date(), updatedAt: new Date(),
        };
        const app = await buildApp();
        const response = await app.inject({ method: 'POST', url: '/v1/auth/response', payload: {
            publicKey,
            response: '界'.repeat(2000),
        } });

        expect(response.statusCode).toBe(400);
        expect(storeMock.approvePairingRow).not.toHaveBeenCalled();
        await app.close();
    });

    it('rejects legacy pairing approval for an E2EE account', async () => {
        dbMock.account.findUnique.mockResolvedValueOnce({ cryptoMode: 'e2ee-v1' });
        state.row = {
            id: 'pending', publicKey, supportsV2: true, claimSecretHash: claimSecretHash(claim),
            response: null, responseAccountId: null, createdAt: new Date(), updatedAt: new Date(),
        };
        const app = await buildApp();
        const response = await app.inject({
            method: 'POST', url: '/v1/auth/response', payload: { publicKey, response: 'ciphertext' },
        });
        expect(response.statusCode).toBe(426);
        expect(response.json()).toEqual({ error: 'e2ee_client_required' });
        expect(storeMock.approvePairingRow).not.toHaveBeenCalled();
        await app.close();
    });
});
