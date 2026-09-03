import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fastify } from './types';
import { applyFakeRateLimitBucket } from '@/app/api/testing/fakeRateLimitBucket';

const { state, dbMock, resetState, emitUpdateSpy } = vi.hoisted(() => {
    const state = {
        sessions: [] as any[],
        machines: [] as any[],
        seq: 0,
        rateCountByKey: new Map<string, number>(),
        transactionTail: Promise.resolve() as Promise<void>,
        nextSession: 1,
    };
    const now = () => new Date('2026-08-24T00:00:00.000Z');
    const resetState = () => {
        state.sessions = [];
        state.machines = [];
        state.seq = 0;
        state.rateCountByKey = new Map();
        state.transactionTail = Promise.resolve();
        state.nextSession = 1;
    };
    const matches = (row: any, where: any) => Object.entries(where).every(([key, value]) => row[key] === value);
    const session = {
        findFirst: vi.fn(async ({ where }: any) => state.sessions.find((row) => matches(row, where)) ?? null),
        findUnique: vi.fn(async ({ where }: any) => state.sessions.find((row) => matches(row, where)) ?? null),
        count: vi.fn(async ({ where }: any) => state.sessions.filter((row) => matches(row, where)).length),
        create: vi.fn(async ({ data }: any) => {
            const row = {
                id: `session-${state.nextSession++}`,
                seq: 0,
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 0,
                dataEncryptionKey: null,
                active: true,
                lastActiveAt: now(),
                createdAt: now(),
                updatedAt: now(),
                ...data,
            };
            state.sessions.push(row);
            return row;
        }),
        update: vi.fn(async ({ where, data }: any) => {
            const row = state.sessions.find((candidate) => candidate.id === where.id);
            if (!row) throw new Error('Session not found');
            Object.assign(row, data, { updatedAt: now() });
            return row;
        }),
        updateMany: vi.fn(async () => ({ count: 0 })),
        findMany: vi.fn(async () => []),
    };
    const machine = {
        findFirst: vi.fn(async ({ where }: any) => state.machines.find((row) => matches(row, where)) ?? null),
        count: vi.fn(async ({ where }: any) => state.machines.filter((row) => matches(row, where)).length),
        create: vi.fn(async ({ data }: any) => {
            const row = {
                seq: 0,
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
                dataEncryptionKey: null,
                active: false,
                lastActiveAt: now(),
                createdAt: now(),
                updatedAt: now(),
                ...data,
            };
            state.machines.push(row);
            return row;
        }),
        update: vi.fn(async ({ where, data }: any) => {
            const composite = where.accountId_id;
            const row = state.machines.find((candidate) => candidate.accountId === composite.accountId && candidate.id === composite.id);
            if (!row) throw new Error('Machine not found');
            Object.assign(row, data, { updatedAt: now() });
            return row;
        }),
        findMany: vi.fn(async () => []),
    };
    const account = {
        update: vi.fn(async () => ({ seq: ++state.seq })),
    };
    const rawQuery = vi.fn(async (sql: string, ...args: any[]) => {
        if (sql.includes('INSERT INTO "AuthRateLimitBucket"')) {
            return applyFakeRateLimitBucket(state.rateCountByKey, args);
        }
        if (sql.includes('FROM "Account"') && sql.includes('FOR UPDATE')) return [{ id: String(args[0]) }];
        if (sql.includes('FROM "Session"')) {
            const rows = state.sessions.filter((row) => row.accountId === String(args[0]));
            return [{ bytes: BigInt(rows.reduce((sum, row) => sum
                + Buffer.byteLength(row.metadata, 'utf8')
                + (row.agentState ? Buffer.byteLength(row.agentState, 'utf8') : 0), 0)) }];
        }
        if (sql.includes('FROM "Machine"')) {
            const rows = state.machines.filter((row) => row.accountId === String(args[0]));
            return [{ bytes: BigInt(rows.reduce((sum, row) => sum
                + Buffer.byteLength(row.metadata, 'utf8')
                + (row.daemonState ? Buffer.byteLength(row.daemonState, 'utf8') : 0), 0)) }];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
    });
    const tx = {
        session,
        machine,
        account,
        $queryRawUnsafe: rawQuery,
        $executeRawUnsafe: vi.fn(async () => 0),
    };
    const dbMock = {
        ...tx,
        $transaction: vi.fn(async (fn: any) => {
            const previous = state.transactionTail;
            let release!: () => void;
            state.transactionTail = new Promise<void>((resolve) => { release = resolve; });
            await previous;
            try {
                return await fn(tx);
            } finally {
                release();
            }
        }),
    };
    return { state, dbMock, resetState, emitUpdateSpy: vi.fn() };
});

vi.mock('@/storage/db', () => ({ db: dbMock }));
vi.mock('@/utils/log', () => ({ log: vi.fn() }));
vi.mock('@/app/events/eventRouter', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/app/events/eventRouter')>();
    return { ...actual, eventRouter: { emitUpdate: emitUpdateSpy, emitEphemeral: vi.fn() } };
});
vi.mock('@/app/presence/sessionCache', () => ({
    activityCache: {
        isSessionValid: vi.fn(async () => true),
        isMachineValid: vi.fn(async () => true),
        queueSessionUpdate: vi.fn(),
        queueMachineUpdate: vi.fn(),
    },
}));

import {
    MACHINE_DAEMON_STATE_MAX_BYTES,
    SESSION_AGENT_STATE_MAX_BYTES,
    createMachineWithQuota,
    createSessionWithQuota,
    machineDaemonStateValueSchema,
    sessionAgentStateSchema,
    updateMachineStateWithQuota,
    updateSessionStateWithQuota,
} from '@/app/state/accountStateStore';
import { machinesRoutes } from './routes/machinesRoutes';
import { sessionRoutes } from './routes/sessionRoutes';
import { machineUpdateHandler } from './socket/machineUpdateHandler';
import { sessionUpdateHandler } from './socket/sessionUpdateHandler';

async function createApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any) => { request.userId = 'account-1'; });
    sessionRoutes(typed);
    machinesRoutes(typed);
    await typed.ready();
    return typed;
}

function fakeSocket() {
    const handlers = new Map<string, (...args: any[]) => any>();
    return {
        handlers,
        socket: {
            id: 'socket-1',
            data: { happyClient: 'test/1' },
            handshake: { auth: {} },
            on: vi.fn((event: string, handler: (...args: any[]) => any) => { handlers.set(event, handler); }),
        } as any,
    };
}

describe('session/machine persistent state quotas', () => {
    beforeEach(() => {
        resetState();
        emitUpdateSpy.mockClear();
        process.env.MAX_SESSION_STATE_WRITE_UNITS_PER_ACCOUNT_PER_MINUTE = '0';
        process.env.MAX_MACHINE_STATE_WRITE_UNITS_PER_ACCOUNT_PER_MINUTE = '0';
        delete process.env.MAX_SESSION_STATE_BYTES_PER_ACCOUNT;
        delete process.env.MAX_MACHINE_STATE_BYTES_PER_ACCOUNT;
    });
    afterEach(() => {
        delete process.env.MAX_SESSION_STATE_WRITE_UNITS_PER_ACCOUNT_PER_MINUTE;
        delete process.env.MAX_MACHINE_STATE_WRITE_UNITS_PER_ACCOUNT_PER_MINUTE;
        delete process.env.MAX_SESSION_STATE_BYTES_PER_ACCOUNT;
        delete process.env.MAX_MACHINE_STATE_BYTES_PER_ACCOUNT;
    });

    it('enforces exact UTF-8 field ceilings before HTTP storage', async () => {
        expect(sessionAgentStateSchema.safeParse('a'.repeat(SESSION_AGENT_STATE_MAX_BYTES)).success).toBe(true);
        expect(sessionAgentStateSchema.safeParse('a'.repeat(SESSION_AGENT_STATE_MAX_BYTES + 1)).success).toBe(false);
        expect(machineDaemonStateValueSchema.safeParse('a'.repeat(MACHINE_DAEMON_STATE_MAX_BYTES)).success).toBe(true);
        expect(machineDaemonStateValueSchema.safeParse('a'.repeat(MACHINE_DAEMON_STATE_MAX_BYTES + 1)).success).toBe(false);

        const app = await createApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/sessions',
            payload: { tag: 'oversize', metadata: 'ok', agentState: 'a'.repeat(SESSION_AGENT_STATE_MAX_BYTES + 1) },
        });
        expect(response.statusCode).toBe(400);
        expect(state.sessions).toHaveLength(0);
        await app.close();
    });

    it('serializes concurrent HTTP-style creates at the account byte boundary', async () => {
        process.env.MAX_SESSION_STATE_BYTES_PER_ACCOUNT = '10';
        const results = await Promise.allSettled([
            createSessionWithQuota({ accountId: 'account-1', tag: 'one', metadata: '123456' }),
            createSessionWithQuota({ accountId: 'account-1', tag: 'two', metadata: '123456' }),
        ]);
        expect(state.sessions).toHaveLength(1);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
        expect(rejected.reason).toMatchObject({ code: 'session_state_bytes_quota_exceeded', statusCode: 413 });
    });

    it('charges update deltas and permits a shrinking write when already at the limit', async () => {
        process.env.MAX_MACHINE_STATE_BYTES_PER_ACCOUNT = '10';
        await createMachineWithQuota({ accountId: 'account-1', id: 'machine-1', metadata: '12345', daemonState: '12345' });
        const exact = await updateMachineStateWithQuota({
            accountId: 'account-1', machineId: 'machine-1', field: 'metadata', value: '12345', expectedVersion: 1,
        });
        expect(exact.kind).toBe('success');
        await expect(updateMachineStateWithQuota({
            accountId: 'account-1', machineId: 'machine-1', field: 'daemonState', value: '123456', expectedVersion: 1,
        })).rejects.toMatchObject({ code: 'machine_state_bytes_quota_exceeded' });
        const shrink = await updateMachineStateWithQuota({
            accountId: 'account-1', machineId: 'machine-1', field: 'daemonState', value: '1', expectedVersion: 1,
        });
        expect(shrink.kind).toBe('success');
    });

    it('uses the same store for Socket updates and returns stable quota failures', async () => {
        process.env.MAX_SESSION_STATE_BYTES_PER_ACCOUNT = '5';
        await createSessionWithQuota({ accountId: 'account-1', tag: 'socket', metadata: '12345' });
        const { socket, handlers } = fakeSocket();
        sessionUpdateHandler('account-1', socket, { connectionType: 'user-scoped' } as any);
        const answer = await new Promise<any>((resolve) => handlers.get('update-state')?.({
            sid: state.sessions[0].id,
            agentState: 'x',
            expectedVersion: 0,
        }, resolve));
        expect(answer).toEqual({ result: 'error', error: 'session_state_bytes_quota_exceeded' });
        expect(state.sessions[0].agentState).toBeNull();
    });

    it('shares one weighted DB rate across metadata and state mutation events', async () => {
        process.env.MAX_MACHINE_STATE_WRITE_UNITS_PER_ACCOUNT_PER_MINUTE = '1';
        await createMachineWithQuota({ accountId: 'account-1', id: 'machine-rate', metadata: 'a' });
        process.env.MAX_MACHINE_STATE_WRITE_UNITS_PER_ACCOUNT_PER_MINUTE = '2';
        const { socket, handlers } = fakeSocket();
        machineUpdateHandler('account-1', socket);
        const first = await new Promise<any>((resolve) => handlers.get('machine-update-metadata')?.({
            machineId: 'machine-rate', metadata: 'b', expectedVersion: 1,
        }, resolve));
        expect(first.result).toBe('success');
        const second = await new Promise<any>((resolve) => handlers.get('machine-update-state')?.({
            machineId: 'machine-rate', daemonState: 'c', expectedVersion: 0,
        }, resolve));
        expect(second).toMatchObject({ result: 'error', error: 'machine_state_rate_quota_exceeded' });
    });

    it('stores initial agent state and preserves version semantics', async () => {
        const result = await createSessionWithQuota({
            accountId: 'account-1', tag: 'initial-state', metadata: 'metadata', agentState: 'state',
        });
        expect(result.kind).toBe('success');
        if (result.kind === 'success') {
            expect(result.session.agentState).toBe('state');
            expect(result.session.agentStateVersion).toBe(1);
        }
        const updated = await updateSessionStateWithQuota({
            accountId: 'account-1', sessionId: state.sessions[0].id, field: 'agentState', value: null, expectedVersion: 1,
        });
        expect(updated.kind).toBe('success');
        expect(state.sessions[0].agentState).toBeNull();
        expect(state.sessions[0].agentStateVersion).toBe(2);
    });
});
