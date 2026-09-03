import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fastify } from '../types';
import { applyFakeRateLimitBucket } from '@/app/api/testing/fakeRateLimitBucket';

const { state, dbMock, resetState } = vi.hoisted(() => {
    type ArtifactRow = {
        id: string;
        accountId: string;
        header: Uint8Array;
        headerVersion: number;
        body: Uint8Array;
        bodyVersion: number;
        dataEncryptionKey: Uint8Array;
        seq: number;
        createdAt: Date;
        updatedAt: Date;
    };
    const state = {
        artifacts: [] as ArtifactRow[],
        rateCountByKey: new Map<string, number>(),
        transactionTail: Promise.resolve() as Promise<void>,
        now: 1_700_000_000_000,
    };
    const resetState = () => {
        state.artifacts = [];
        state.rateCountByKey = new Map();
        state.transactionTail = Promise.resolve();
        state.now = 1_700_000_000_000;
    };
    const artifact = {
        findUnique: vi.fn(async ({ where }: any) => state.artifacts.find((row) => row.id === where.id) ?? null),
        findFirst: vi.fn(async ({ where }: any) => state.artifacts.find((row) => (
            row.id === where.id && (where.accountId === undefined || row.accountId === where.accountId)
        )) ?? null),
        findMany: vi.fn(async ({ where }: any) => state.artifacts.filter((row) => row.accountId === where.accountId)),
        create: vi.fn(async ({ data }: any) => {
            const now = new Date(state.now++);
            const row: ArtifactRow = { ...data, createdAt: now, updatedAt: now };
            state.artifacts.push(row);
            return row;
        }),
        update: vi.fn(async ({ where, data }: any) => {
            const row = state.artifacts.find((item) => item.id === where.id);
            if (!row) throw new Error('Artifact not found');
            Object.assign(row, data, { updatedAt: data.updatedAt ?? new Date(state.now++) });
            return row;
        }),
        delete: vi.fn(async ({ where }: any) => {
            const index = state.artifacts.findIndex((row) => row.id === where.id);
            if (index < 0) throw new Error('Artifact not found');
            return state.artifacts.splice(index, 1)[0];
        }),
    };
    const rawQuery = vi.fn(async (sql: string, ...args: any[]) => {
        if (sql.includes('INSERT INTO "AuthRateLimitBucket"')) {
            return applyFakeRateLimitBucket(state.rateCountByKey, args);
        }
        if (sql.includes('FROM "Account"') && sql.includes('FOR UPDATE')) return [{ id: String(args[0]) }];
        if (sql.includes('FROM "Artifact"')) {
            const rows = state.artifacts.filter((row) => row.accountId === String(args[0]));
            return [{
                count: BigInt(rows.length),
                bytes: BigInt(rows.reduce((total, row) => (
                    total + row.header.byteLength + row.body.byteLength + row.dataEncryptionKey.byteLength
                ), 0)),
            }];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
    });
    const tx = {
        artifact,
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
    return { state, dbMock, resetState };
});

vi.mock('@/storage/db', () => ({ db: dbMock }));
vi.mock('@/storage/seq', () => ({ allocateUserSeq: vi.fn(async () => 1) }));
vi.mock('@/app/monitoring/metrics2', () => ({
    getMetricsLabelsFromSocket: () => ({}),
    websocketEventsCounter: { inc: vi.fn() },
}));
vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: { emitUpdate: vi.fn() },
    buildNewArtifactUpdate: vi.fn(() => ({})),
    buildUpdateArtifactUpdate: vi.fn(() => ({})),
    buildDeleteArtifactUpdate: vi.fn(() => ({})),
}));
vi.mock('@/utils/randomKeyNaked', () => ({ randomKeyNaked: () => 'update-id' }));
vi.mock('@/utils/log', () => ({ log: vi.fn() }));

import {
    ARTIFACT_HEADER_MAX_BYTES,
    artifactCreateSchema,
} from '@/app/artifacts/artifactStore';
import { artifactUpdateHandler } from '../socket/artifactUpdateHandler';
import { artifactsRoutes } from './artifactsRoutes';

async function createApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any, reply: any) => {
        const userId = request.headers['x-user-id'];
        if (typeof userId !== 'string') return reply.code(401).send({ error: 'Unauthorized' });
        request.userId = userId;
    });
    artifactsRoutes(typed);
    await typed.ready();
    return typed;
}

function createSocket(userId = 'user-1') {
    const handlers = new Map<string, (...args: any[]) => any>();
    const socket = { id: `socket-${userId}`, on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler) };
    artifactUpdateHandler(userId, socket as any);
    return {
        invoke(event: string, data: unknown) {
            return new Promise<any>((resolve, reject) => {
                Promise.resolve(handlers.get(event)?.(data, resolve)).catch(reject);
            });
        },
    };
}

function artifactPayload(id = crypto.randomUUID(), bytes = 1) {
    const value = Buffer.alloc(bytes, 7).toString('base64');
    return { id, header: value, body: value, dataEncryptionKey: value };
}

describe('artifact account quotas across HTTP and Socket.IO', () => {
    let app: Fastify;
    beforeEach(async () => {
        resetState();
        process.env.MAX_ARTIFACT_WRITES_PER_ACCOUNT_PER_MINUTE = '0';
        delete process.env.MAX_ARTIFACTS_PER_ACCOUNT;
        delete process.env.MAX_ARTIFACT_BYTES_PER_ACCOUNT;
        app = await createApp();
    });
    afterEach(async () => {
        await app.close();
        delete process.env.MAX_ARTIFACT_WRITES_PER_ACCOUNT_PER_MINUTE;
        delete process.env.MAX_ARTIFACTS_PER_ACCOUNT;
        delete process.env.MAX_ARTIFACT_BYTES_PER_ACCOUNT;
    });

    it('atomically permits only one concurrent create across HTTP and socket', async () => {
        process.env.MAX_ARTIFACTS_PER_ACCOUNT = '1';
        const socket = createSocket();
        const [http, socketResult] = await Promise.all([
            app.inject({
                method: 'POST', url: '/v1/artifacts', headers: { 'x-user-id': 'user-1' }, payload: artifactPayload(),
            }),
            socket.invoke('artifact-create', artifactPayload()),
        ]);

        expect(state.artifacts).toHaveLength(1);
        const successes = Number(http.statusCode === 200) + Number(socketResult.result === 'success');
        expect(successes).toBe(1);
        if (http.statusCode !== 200) expect(http.json()).toEqual({ error: 'artifact_count_quota_exceeded' });
        if (socketResult.result !== 'success') expect(socketResult.message).toBe('artifact_count_quota_exceeded');
    });

    it('counts create bytes and update byte deltas at the exact boundary', async () => {
        process.env.MAX_ARTIFACT_BYTES_PER_ACCOUNT = '3';
        const create = await app.inject({
            method: 'POST', url: '/v1/artifacts', headers: { 'x-user-id': 'user-1' }, payload: artifactPayload(),
        });
        expect(create.statusCode).toBe(200);

        const id = state.artifacts[0].id;
        process.env.MAX_ARTIFACT_BYTES_PER_ACCOUNT = '4';
        const exactHeader = Buffer.alloc(2, 8).toString('base64');
        const exact = await app.inject({
            method: 'POST',
            url: `/v1/artifacts/${id}`,
            headers: { 'x-user-id': 'user-1' },
            payload: { header: exactHeader, expectedHeaderVersion: 1 },
        });
        expect(exact.statusCode).toBe(200);

        const socket = createSocket();
        const overflow = await socket.invoke('artifact-update', {
            artifactId: id,
            body: { data: Buffer.alloc(2, 9).toString('base64'), expectedVersion: 1 },
        });
        expect(overflow).toEqual({ result: 'error', message: 'artifact_bytes_quota_exceeded' });
        expect(state.artifacts[0].body.byteLength).toBe(1);
    });

    it('applies canonical base64 and decoded field byte boundaries to both transports', async () => {
        const exact = Buffer.alloc(ARTIFACT_HEADER_MAX_BYTES).toString('base64');
        const over = Buffer.alloc(ARTIFACT_HEADER_MAX_BYTES + 1).toString('base64');
        expect(artifactCreateSchema.safeParse({ ...artifactPayload(), header: exact }).success).toBe(true);
        expect(artifactCreateSchema.safeParse({ ...artifactPayload(), header: over }).success).toBe(false);

        const invalidHttp = await app.inject({
            method: 'POST',
            url: '/v1/artifacts',
            headers: { 'x-user-id': 'user-1' },
            payload: { ...artifactPayload(), header: 'not base64' },
        });
        expect(invalidHttp.statusCode).toBe(400);
        const invalidSocket = await createSocket().invoke('artifact-create', { ...artifactPayload(), body: 'not base64' });
        expect(invalidSocket).toEqual({ result: 'error', message: 'Invalid parameters' });
    });

    it('shares a stable per-account write rate across HTTP and socket', async () => {
        process.env.MAX_ARTIFACT_WRITES_PER_ACCOUNT_PER_MINUTE = '1';
        const first = await app.inject({
            method: 'POST', url: '/v1/artifacts', headers: { 'x-user-id': 'user-1' }, payload: artifactPayload(),
        });
        expect(first.statusCode).toBe(200);
        const second = await createSocket().invoke('artifact-create', artifactPayload());
        expect(second).toEqual({ result: 'error', message: 'artifact_rate_quota_exceeded' });
        expect(state.artifacts).toHaveLength(1);
    });
});
