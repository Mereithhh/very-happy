import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fastify } from '../types';
import { applyFakeRateLimitBucket } from '@/app/api/testing/fakeRateLimitBucket';

const { state, dbMock, resetState } = vi.hoisted(() => {
    type KVRow = { id: string; accountId: string; key: string; value: Uint8Array | null; version: number; createdAt: Date; updatedAt: Date };
    const state = {
        rows: [] as KVRow[],
        rateCountByKey: new Map<string, number>(),
        transactionTail: Promise.resolve() as Promise<void>,
        nextId: 1,
    };
    const resetState = () => {
        state.rows = [];
        state.rateCountByKey = new Map();
        state.transactionTail = Promise.resolve();
        state.nextId = 1;
    };
    const userKVStore = {
        findUnique: vi.fn(async ({ where }: any) => {
            const key = where.accountId_key;
            return state.rows.find((row) => row.accountId === key.accountId && row.key === key.key) ?? null;
        }),
        create: vi.fn(async ({ data }: any) => {
            const now = new Date();
            const row: KVRow = { id: `kv-${state.nextId++}`, ...data, createdAt: now, updatedAt: now };
            state.rows.push(row);
            return row;
        }),
        update: vi.fn(async ({ where, data }: any) => {
            const key = where.accountId_key;
            const row = state.rows.find((item) => item.accountId === key.accountId && item.key === key.key);
            if (!row) throw new Error('KV row not found');
            Object.assign(row, data, { updatedAt: new Date() });
            return row;
        }),
        findMany: vi.fn(async () => []),
    };
    const rawQuery = vi.fn(async (sql: string, ...args: any[]) => {
        if (sql.includes('INSERT INTO "AuthRateLimitBucket"')) {
            return applyFakeRateLimitBucket(state.rateCountByKey, args);
        }
        if (sql.includes('FROM "Account"') && sql.includes('FOR UPDATE')) return [{ id: String(args[0]) }];
        if (sql.includes('FROM "UserKVStore"')) {
            const rows = state.rows.filter((row) => row.accountId === String(args[0]));
            return [{
                count: BigInt(rows.length),
                bytes: BigInt(rows.reduce((total, row) => total + Buffer.byteLength(row.key, 'utf8') + (row.value?.byteLength ?? 0), 0)),
            }];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
    });
    const tx = { userKVStore, $queryRawUnsafe: rawQuery, $executeRawUnsafe: vi.fn(async () => 0) };
    const dbMock = {
        ...tx,
        $transaction: vi.fn(async (fn: any) => {
            const previous = state.transactionTail;
            let release!: () => void;
            state.transactionTail = new Promise<void>((resolve) => { release = resolve; });
            await previous;
            try { return await fn(tx); } finally { release(); }
        }),
    };
    return { state, dbMock, resetState };
});

vi.mock('@/storage/db', () => ({ db: dbMock }));
vi.mock('@/storage/seq', () => ({ allocateUserSeq: vi.fn(async () => 1) }));
vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: { emitUpdate: vi.fn() },
    buildKVBatchUpdateUpdate: vi.fn(() => ({})),
}));
vi.mock('@/utils/randomKeyNaked', () => ({ randomKeyNaked: () => 'update-id' }));
vi.mock('@/utils/log', () => ({ log: vi.fn() }));

import { KV_KEY_MAX_BYTES, KV_VALUE_MAX_BYTES, kvMutationsBodySchema } from '@/app/kv/kvMutate';
import { kvRoutes } from './kvRoutes';

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
    kvRoutes(typed);
    await typed.ready();
    return typed;
}

function mutate(app: Fastify, mutations: Array<{ key: string; value: string | null; version: number }>) {
    return app.inject({ method: 'POST', url: '/v1/kv', headers: { 'x-user-id': 'user-1' }, payload: { mutations } });
}

describe('KV account storage quotas', () => {
    let app: Fastify;
    beforeEach(async () => {
        resetState();
        process.env.MAX_KV_WRITES_PER_ACCOUNT_PER_MINUTE = '0';
        delete process.env.MAX_KV_ENTRIES_PER_ACCOUNT;
        delete process.env.MAX_KV_BYTES_PER_ACCOUNT;
        app = await createApp();
    });
    afterEach(async () => {
        await app.close();
        delete process.env.MAX_KV_WRITES_PER_ACCOUNT_PER_MINUTE;
        delete process.env.MAX_KV_ENTRIES_PER_ACCOUNT;
        delete process.env.MAX_KV_BYTES_PER_ACCOUNT;
    });

    it('serializes concurrent creates at the account count boundary', async () => {
        process.env.MAX_KV_ENTRIES_PER_ACCOUNT = '1';
        const value = Buffer.from('v').toString('base64');
        const [left, right] = await Promise.all([
            mutate(app, [{ key: 'left', value, version: -1 }]),
            mutate(app, [{ key: 'right', value, version: -1 }]),
        ]);
        expect(state.rows).toHaveLength(1);
        expect([left.statusCode, right.statusCode].sort()).toEqual([200, 429]);
        const rejected = left.statusCode === 429 ? left : right;
        expect(rejected.json()).toEqual({ error: 'kv_count_quota_exceeded' });
    });

    it('charges only the value delta on updates and accepts the exact byte boundary', async () => {
        const oneByte = Buffer.alloc(1).toString('base64');
        expect((await mutate(app, [{ key: 'k', value: oneByte, version: -1 }])).statusCode).toBe(200);
        process.env.MAX_KV_BYTES_PER_ACCOUNT = '3'; // one-byte key + two-byte value
        const exact = await mutate(app, [{ key: 'k', value: Buffer.alloc(2).toString('base64'), version: 0 }]);
        expect(exact.statusCode).toBe(200);
        const overflow = await mutate(app, [{ key: 'k', value: Buffer.alloc(3).toString('base64'), version: 1 }]);
        expect(overflow.statusCode).toBe(413);
        expect(overflow.json()).toEqual({ error: 'kv_bytes_quota_exceeded' });
        expect(state.rows[0].value?.byteLength).toBe(2);
    });

    it('bounds UTF-8 keys and decoded values and rejects duplicate batch keys', async () => {
        const exactKey = 'é'.repeat(KV_KEY_MAX_BYTES / 2);
        const overKey = `${exactKey}a`;
        const exactValue = Buffer.alloc(KV_VALUE_MAX_BYTES).toString('base64');
        const overValue = Buffer.alloc(KV_VALUE_MAX_BYTES + 1).toString('base64');
        expect(kvMutationsBodySchema.safeParse({ mutations: [{ key: exactKey, value: exactValue, version: -1 }] }).success).toBe(true);
        expect(kvMutationsBodySchema.safeParse({ mutations: [{ key: overKey, value: exactValue, version: -1 }] }).success).toBe(false);
        expect(kvMutationsBodySchema.safeParse({ mutations: [{ key: 'k', value: overValue, version: -1 }] }).success).toBe(false);
        expect((await mutate(app, [
            { key: 'same', value: null, version: -1 },
            { key: 'same', value: null, version: -1 },
        ])).statusCode).toBe(400);
    });

    it('charges batch mutations against one shared database-backed rate bucket', async () => {
        process.env.MAX_KV_WRITES_PER_ACCOUNT_PER_MINUTE = '1';
        const response = await mutate(app, [
            { key: 'a', value: null, version: -1 },
            { key: 'b', value: null, version: -1 },
        ]);
        expect(response.statusCode).toBe(429);
        expect(response.json()).toEqual({ error: 'kv_rate_quota_exceeded' });
        expect(state.rows).toHaveLength(0);
    });
});
