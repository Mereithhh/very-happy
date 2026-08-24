import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fastify } from '../types';
import { canonicalizeE2eeJson, type E2eeStoredDomain } from '@slopus/happy-wire';

const { state, dbMock, resetState } = vi.hoisted(() => {
    type KVRow = { id: string; accountId: string; key: string; value: Uint8Array | null; version: number; createdAt: Date; updatedAt: Date };
    const state = {
        rows: [] as KVRow[],
        rateCountByKey: new Map<string, number>(),
        transactionTail: Promise.resolve() as Promise<void>,
        nextId: 1,
        cryptoMode: 'trusted-v1' as 'trusted-v1' | 'e2ee-v1',
        cryptoEpoch: 1,
        cryptoWriteState: 'active' as 'active' | 'rekey-required',
        deviceStatus: 'active',
    };
    const resetState = () => {
        state.rows = [];
        state.rateCountByKey = new Map();
        state.transactionTail = Promise.resolve();
        state.nextId = 1;
        state.cryptoMode = 'trusted-v1';
        state.cryptoEpoch = 1;
        state.cryptoWriteState = 'active';
        state.deviceStatus = 'active';
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
        findMany: vi.fn(async ({ where, take }: any) => {
            let rows = state.rows.filter((row) => row.accountId === where.accountId);
            if (where.value?.not === null) rows = rows.filter((row) => row.value !== null);
            if (where.key?.startsWith !== undefined) {
                rows = rows.filter((row) => row.key.startsWith(where.key.startsWith));
            }
            if (Array.isArray(where.key?.in)) rows = rows.filter((row) => where.key.in.includes(row.key));
            rows = [...rows].sort((left, right) => left.key.localeCompare(right.key));
            return typeof take === 'number' ? rows.slice(0, take) : rows;
        }),
    };
    const rawQuery = vi.fn(async (sql: string, ...args: any[]) => {
        if (sql.includes('INSERT INTO "AuthRateLimitBucket"')) {
            const key = String(args[0]);
            const count = (state.rateCountByKey.get(key) ?? 0) + Number(args[3] ?? 1);
            state.rateCountByKey.set(key, count);
            return [{ count }];
        }
        if (sql.includes('FROM "Account"') && sql.includes('FOR UPDATE')) return [{
            id: String(args[0]),
            cryptoMode: state.cryptoMode,
            cryptoEpoch: state.cryptoMode === 'e2ee-v1' ? state.cryptoEpoch : 0,
            cryptoWriteState: state.cryptoWriteState,
            e2eeOrigin: state.cryptoMode === 'e2ee-v1' ? 'https://happy.example.com' : null,
            sessionId: state.cryptoMode === 'e2ee-v1' ? 'login-1' : null,
            sessionDeviceId: state.cryptoMode === 'e2ee-v1' ? 'device-1' : null,
            sessionCapabilities: state.cryptoMode === 'e2ee-v1' ? ['e2ee:control'] : null,
            sessionProtocol: state.cryptoMode === 'e2ee-v1' ? 'vh-e2ee-1' : null,
            sessionExpiresAt: state.cryptoMode === 'e2ee-v1' ? new Date(Date.now() + 60_000) : null,
            sessionRevokedAt: null,
            deviceId: state.cryptoMode === 'e2ee-v1' ? 'device-1' : null,
            deviceStatus: state.cryptoMode === 'e2ee-v1' ? state.deviceStatus : null,
            deviceKeyEpoch: state.cryptoMode === 'e2ee-v1' ? state.cryptoEpoch : null,
            deviceRevokedAt: state.deviceStatus === 'revoked' ? new Date() : null,
        }];
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
    const account = {
        findUnique: vi.fn(async ({ where }: any) => where.id === 'user-1' ? {
            id: 'user-1', cryptoMode: state.cryptoMode,
            cryptoEpoch: state.cryptoMode === 'e2ee-v1' ? state.cryptoEpoch : 0,
            cryptoWriteState: state.cryptoWriteState,
            e2eeOrigin: state.cryptoMode === 'e2ee-v1' ? 'https://happy.example.com' : null,
        } : null),
    };
    const dbMock = {
        ...tx,
        account,
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
        if (state.cryptoMode === 'e2ee-v1') {
            request.authLoginSessionId = 'login-1';
            request.authDeviceId = 'device-1';
            request.authCapabilities = ['e2ee:control'];
            request.authE2eeProtocol = 'vh-e2ee-1';
        }
    });
    kvRoutes(typed);
    await typed.ready();
    return typed;
}

function mutate(app: Fastify, mutations: Array<{ key: string; value: string | null; version: number }>) {
    return app.inject({ method: 'POST', url: '/v1/kv', headers: { 'x-user-id': 'user-1' }, payload: { mutations } });
}

function e2eeValue(key: string, domain: E2eeStoredDomain = 'kv', overrides: Record<string, unknown> = {}) {
    const serialized = canonicalizeE2eeJson({
        accountId: 'user-1',
        ciphertext: Buffer.alloc(16, 2).toString('base64url'),
        domain,
        epoch: 1,
        field: 'value',
        nonce: Buffer.alloc(12, 1).toString('base64url'),
        objectId: key,
        origin: 'https://happy.example.com',
        suite: 'vh-e2ee-1',
        v: 1,
        ...overrides,
    } as any);
    return Buffer.from(serialized, 'utf8').toString('base64');
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

describe('KV E2EE data guard', () => {
    let app: Fastify;
    beforeEach(async () => {
        resetState();
        state.cryptoMode = 'e2ee-v1';
        process.env.MAX_KV_WRITES_PER_ACCOUNT_PER_MINUTE = '0';
        app = await createApp();
    });
    afterEach(async () => {
        await app.close();
        delete process.env.MAX_KV_WRITES_PER_ACCOUNT_PER_MINUTE;
    });

    it('stores and returns an opaque canonical task envelope', async () => {
        const value = e2eeValue('vh.board-tasks.v1', 'tasks');
        expect((await mutate(app, [{ key: 'vh.board-tasks.v1', value, version: -1 }])).json())
            .toEqual({ success: true, results: [{ key: 'vh.board-tasks.v1', version: 0 }] });
        const read = await app.inject({
            method: 'GET', url: '/v1/kv/vh.board-tasks.v1', headers: { 'x-user-id': 'user-1' },
        });
        expect(read.statusCode).toBe(200);
        expect(read.json()).toEqual({ key: 'vh.board-tasks.v1', value, version: 0 });
    });

    it('validates every opaque envelope before returning list or bulk responses', async () => {
        const noteKey = 'vh.note.v1.note-1';
        const noteValue = e2eeValue(noteKey, 'notes');
        const kvValue = e2eeValue('plain-key');
        expect((await mutate(app, [
            { key: noteKey, value: noteValue, version: -1 },
            { key: 'plain-key', value: kvValue, version: -1 },
        ])).statusCode).toBe(200);

        const listed = await app.inject({
            method: 'GET', url: '/v1/kv?prefix=vh.note.v1.', headers: { 'x-user-id': 'user-1' },
        });
        expect(listed.statusCode).toBe(200);
        expect(listed.json()).toEqual({ items: [{ key: noteKey, value: noteValue, version: 0 }] });
        const bulk = await app.inject({
            method: 'POST', url: '/v1/kv/bulk', headers: { 'x-user-id': 'user-1' },
            payload: { keys: [noteKey, 'plain-key'] },
        });
        expect(bulk.statusCode).toBe(200);
        expect(bulk.json().values).toHaveLength(2);

        state.rows.find((row) => row.key === 'plain-key')!.value = Buffer.from('legacy secret', 'utf8');
        const blocked = await app.inject({
            method: 'POST', url: '/v1/kv/bulk', headers: { 'x-user-id': 'user-1' },
            payload: { keys: [noteKey, 'plain-key'] },
        });
        expect(blocked.statusCode).toBe(409);
        expect(blocked.json()).toEqual({ error: 'e2ee_data_invalid' });
        expect(blocked.body).not.toContain('legacy secret');
    });

    it('rejects plaintext and wrong domain without partially applying a bulk mutation', async () => {
        const original = e2eeValue('a');
        expect((await mutate(app, [{ key: 'a', value: original, version: -1 }])).statusCode).toBe(200);
        const plaintext = Buffer.from('secret board title', 'utf8').toString('base64');
        const rejected = await mutate(app, [
            { key: 'a', value: e2eeValue('a'), version: 0 },
            { key: 'b', value: plaintext, version: -1 },
        ]);
        expect(rejected.statusCode).toBe(400);
        expect(rejected.json()).toEqual({ error: 'invalid_e2ee_envelope' });
        expect(state.rows).toHaveLength(1);
        expect(state.rows[0].version).toBe(0);
        expect(Buffer.from(state.rows[0].value!).toString('base64')).toBe(original);

        const wrongDomain = await mutate(app, [{
            key: 'vh.note.v1.note-1', value: e2eeValue('vh.note.v1.note-1', 'kv'), version: -1,
        }]);
        expect(wrongDomain.statusCode).toBe(400);
        expect(wrongDomain.json()).toEqual({ error: 'invalid_e2ee_envelope' });
    });

    it('keeps CAS behavior and rejects writes and deletes while rekey is required', async () => {
        const value = e2eeValue('k');
        expect((await mutate(app, [{ key: 'k', value, version: -1 }])).statusCode).toBe(200);
        const cas = await mutate(app, [{ key: 'k', value, version: -1 }]);
        expect(cas.statusCode).toBe(409);
        expect(cas.json()).toMatchObject({ success: false, errors: [{ key: 'k', error: 'version-mismatch', version: 0 }] });

        state.cryptoWriteState = 'rekey-required';
        const blocked = await mutate(app, [{ key: 'k', value: null, version: 0 }]);
        expect(blocked.statusCode).toBe(409);
        expect(blocked.json()).toEqual({ error: 'e2ee_rekey_required' });
        expect(state.rows[0].value).not.toBeNull();
    });

    it('never leaks a polluted legacy value through a CAS conflict response', async () => {
        const value = e2eeValue('k');
        expect((await mutate(app, [{ key: 'k', value, version: -1 }])).statusCode).toBe(200);
        state.rows[0].value = Buffer.from('legacy secret', 'utf8');
        const response = await mutate(app, [{ key: 'k', value, version: -1 }]);
        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ error: 'e2ee_data_invalid' });
        expect(response.body).not.toContain(Buffer.from('legacy secret').toString('base64'));
    });

    it('allows historical reads and CAS re-encryption but rejects future reads and stale new writes', async () => {
        state.cryptoEpoch = 2;
        const historical = e2eeValue('k', 'kv', { epoch: 1 });
        state.rows.push({
            id: 'kv-history', accountId: 'user-1', key: 'k',
            value: Buffer.from(historical, 'base64'), version: 0,
            createdAt: new Date(), updatedAt: new Date(),
        });

        const historicalRead = await app.inject({
            method: 'GET', url: '/v1/kv/k', headers: { 'x-user-id': 'user-1' },
        });
        expect(historicalRead.statusCode).toBe(200);
        expect(historicalRead.json()).toEqual({ key: 'k', value: historical, version: 0 });

        const current = e2eeValue('k', 'kv', { epoch: 2 });
        const reencrypted = await mutate(app, [{ key: 'k', value: current, version: 0 }]);
        expect(reencrypted.statusCode).toBe(200);
        expect(state.rows[0].version).toBe(1);

        const staleWrite = await mutate(app, [{ key: 'stale', value: e2eeValue('stale', 'kv', { epoch: 1 }), version: -1 }]);
        expect(staleWrite.statusCode).toBe(400);
        expect(staleWrite.json()).toEqual({ error: 'invalid_e2ee_envelope' });

        state.rows[0].value = Buffer.from(e2eeValue('k', 'kv', { epoch: 3 }), 'base64');
        const futureRead = await app.inject({
            method: 'GET', url: '/v1/kv/k', headers: { 'x-user-id': 'user-1' },
        });
        expect(futureRead.statusCode).toBe(409);
        expect(futureRead.json()).toEqual({ error: 'e2ee_data_invalid' });
    });

    it('rejects a no-longer-active device with the stable upgrade response', async () => {
        state.deviceStatus = 'revoked';
        const response = await mutate(app, [{ key: 'k', value: e2eeValue('k'), version: -1 }]);
        expect(response.statusCode).toBe(426);
        expect(response.json()).toEqual({ error: 'e2ee_client_required' });
        expect(state.rows).toHaveLength(0);
    });

    it('preserves legacy trusted-v1 plaintext behavior', async () => {
        state.cryptoMode = 'trusted-v1';
        const value = Buffer.from('legacy plaintext', 'utf8').toString('base64');
        expect((await mutate(app, [{ key: 'legacy', value, version: -1 }])).statusCode).toBe(200);
        expect(Buffer.from(state.rows[0].value!).toString('utf8')).toBe('legacy plaintext');
    });
});
