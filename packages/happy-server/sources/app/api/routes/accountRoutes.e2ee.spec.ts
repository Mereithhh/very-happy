import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalizeE2eeJson } from '@slopus/happy-wire';
import type { Fastify } from '../types';

const { state, dbMock, resetState } = vi.hoisted(() => {
    const state = {
        settings: null as string | null,
        settingsVersion: 0,
        cryptoMode: 'e2ee-v1' as 'trusted-v1' | 'e2ee-v1',
        cryptoEpoch: 1,
        cryptoWriteState: 'active' as 'active' | 'rekey-required',
    };
    const resetState = () => {
        state.settings = null;
        state.settingsVersion = 0;
        state.cryptoMode = 'e2ee-v1';
        state.cryptoEpoch = 1;
        state.cryptoWriteState = 'active';
    };
    const accountRow = () => ({
        id: 'user-1',
        settings: state.settings,
        settingsVersion: state.settingsVersion,
        cryptoMode: state.cryptoMode,
        cryptoEpoch: state.cryptoMode === 'e2ee-v1' ? state.cryptoEpoch : 0,
        cryptoWriteState: state.cryptoWriteState,
        e2eeOrigin: state.cryptoMode === 'e2ee-v1' ? 'https://happy.example.com' : null,
    });
    const account = {
        findUnique: vi.fn(async ({ where }: any) => where.id === 'user-1' ? accountRow() : null),
        updateMany: vi.fn(async ({ where, data }: any) => {
            if (where.id !== 'user-1' || where.settingsVersion !== state.settingsVersion) return { count: 0 };
            state.settings = data.settings;
            state.settingsVersion = data.settingsVersion;
            return { count: 1 };
        }),
        findUniqueOrThrow: vi.fn(async () => accountRow()),
    };
    const raw = vi.fn(async (sql: string, ...args: any[]) => {
        if (sql.includes('FROM "Account"') && sql.includes('FOR UPDATE')) return [{
            ...accountRow(),
            sessionId: state.cryptoMode === 'e2ee-v1' ? 'login-1' : null,
            sessionDeviceId: state.cryptoMode === 'e2ee-v1' ? 'device-1' : null,
            sessionCapabilities: state.cryptoMode === 'e2ee-v1' ? ['e2ee:control'] : null,
            sessionProtocol: state.cryptoMode === 'e2ee-v1' ? 'vh-e2ee-1' : null,
            sessionExpiresAt: state.cryptoMode === 'e2ee-v1' ? new Date(Date.now() + 60_000) : null,
            sessionRevokedAt: null,
            deviceId: state.cryptoMode === 'e2ee-v1' ? 'device-1' : null,
            deviceStatus: state.cryptoMode === 'e2ee-v1' ? 'active' : null,
            deviceKeyEpoch: state.cryptoMode === 'e2ee-v1' ? state.cryptoEpoch : null,
            deviceRevokedAt: null,
        }];
        throw new Error(`Unexpected SQL: ${sql}; args=${args.length}`);
    });
    const tx = { account, $queryRawUnsafe: raw };
    const dbMock = {
        account,
        serviceAccountToken: { findMany: vi.fn(async () => []) },
        $queryRawUnsafe: raw,
        $transaction: vi.fn(async (fn: any) => fn(tx)),
    };
    return { state, dbMock, resetState };
});

vi.mock('@/storage/db', () => ({ db: dbMock }));
vi.mock('@/storage/seq', () => ({ allocateUserSeq: vi.fn(async () => 1) }));
vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: { emitUpdate: vi.fn() },
    buildUpdateAccountUpdate: vi.fn(() => ({})),
}));
vi.mock('@/utils/randomKeyNaked', () => ({ randomKeyNaked: () => 'update-id' }));
vi.mock('@/utils/log', () => ({ log: vi.fn() }));

import { accountRoutes } from './accountRoutes';

function settingsEnvelope(overrides: Record<string, unknown> = {}) {
    return canonicalizeE2eeJson({
        accountId: 'user-1',
        ciphertext: Buffer.alloc(16, 2).toString('base64url'),
        domain: 'settings',
        epoch: 1,
        field: 'settings',
        nonce: Buffer.alloc(12, 1).toString('base64url'),
        objectId: 'user-1',
        origin: 'https://happy.example.com',
        suite: 'vh-e2ee-1',
        v: 1,
        ...overrides,
    } as any);
}

async function createApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any) => {
        request.userId = 'user-1';
        if (state.cryptoMode === 'e2ee-v1') {
            request.authLoginSessionId = 'login-1';
            request.authDeviceId = 'device-1';
            request.authCapabilities = ['e2ee:control'];
            request.authE2eeProtocol = 'vh-e2ee-1';
        }
    });
    accountRoutes(typed);
    await typed.ready();
    return typed;
}

function update(app: Fastify, settings: string | null, expectedVersion = 0) {
    return app.inject({
        method: 'POST',
        url: '/v1/account/settings',
        payload: { settings, expectedVersion },
    });
}

describe('account settings E2EE data guard', () => {
    let app: Fastify;
    beforeEach(async () => {
        resetState();
        process.env.MAX_ACCOUNT_SETTINGS_WRITES_PER_ACCOUNT_PER_MINUTE = '0';
        app = await createApp();
    });
    afterEach(async () => {
        await app.close();
        delete process.env.MAX_ACCOUNT_SETTINGS_WRITES_PER_ACCOUNT_PER_MINUTE;
    });

    it('roundtrips only the opaque canonical settings envelope', async () => {
        const settings = settingsEnvelope();
        expect((await update(app, settings)).json()).toEqual({ success: true, version: 1 });
        const read = await app.inject({ method: 'GET', url: '/v1/account/settings' });
        expect(read.statusCode).toBe(200);
        expect(read.json()).toEqual({ settings, settingsVersion: 1 });
    });

    it('rejects plaintext and wrong account context without changing the CAS version', async () => {
        for (const value of ['legacy plaintext', settingsEnvelope({ accountId: 'other' })]) {
            const response = await update(app, value);
            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({ error: 'invalid_e2ee_envelope' });
            expect(state.settings).toBeNull();
            expect(state.settingsVersion).toBe(0);
        }
    });

    it('preserves CAS and blocks all writes while rekey is required', async () => {
        const settings = settingsEnvelope();
        expect((await update(app, settings)).statusCode).toBe(200);
        const mismatch = await update(app, settings, 0);
        expect(mismatch.statusCode).toBe(200);
        expect(mismatch.json()).toEqual({
            success: false,
            error: 'version-mismatch',
            currentVersion: 1,
            currentSettings: settings,
        });

        state.cryptoWriteState = 'rekey-required';
        const blocked = await update(app, null, 1);
        expect(blocked.statusCode).toBe(409);
        expect(blocked.json()).toEqual({ error: 'e2ee_rekey_required' });
        expect(state.settings).toBe(settings);
    });

    it('fails closed instead of returning legacy plaintext from an E2EE row', async () => {
        state.settings = 'legacy plaintext';
        const response = await app.inject({ method: 'GET', url: '/v1/account/settings' });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ error: 'e2ee_data_invalid' });
    });

    it('never leaks a polluted legacy value through the settings CAS response', async () => {
        state.settings = 'legacy plaintext';
        state.settingsVersion = 3;
        const response = await update(app, settingsEnvelope(), 0);
        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ error: 'e2ee_data_invalid' });
        expect(response.body).not.toContain('legacy plaintext');
    });

    it('reads historical settings after rotation but rejects future reads and historical new writes', async () => {
        state.cryptoEpoch = 2;
        const historical = settingsEnvelope({ epoch: 1 });
        state.settings = historical;

        const historicalRead = await app.inject({ method: 'GET', url: '/v1/account/settings' });
        expect(historicalRead.statusCode).toBe(200);
        expect(historicalRead.json()).toEqual({ settings: historical, settingsVersion: 0 });

        const staleWrite = await update(app, historical, 0);
        expect(staleWrite.statusCode).toBe(400);
        expect(staleWrite.json()).toEqual({ error: 'invalid_e2ee_envelope' });

        state.settings = settingsEnvelope({ epoch: 3 });
        const futureRead = await app.inject({ method: 'GET', url: '/v1/account/settings' });
        expect(futureRead.statusCode).toBe(409);
        expect(futureRead.json()).toEqual({ error: 'e2ee_data_invalid' });
    });

    it('keeps trusted-v1 settings compatible', async () => {
        state.cryptoMode = 'trusted-v1';
        const response = await update(app, 'legacy plaintext');
        expect(response.statusCode).toBe(200);
        expect(state.settings).toBe('legacy plaintext');
    });
});
