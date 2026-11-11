import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fastify } from '../types';
import { applyFakeRateLimitBucket } from '@/app/api/testing/fakeRateLimitBucket';

const { state, dbMock, resetState } = vi.hoisted(() => {
    type KVRow = { id: string; accountId: string; key: string; value: Uint8Array | null; version: number; createdAt: Date; updatedAt: Date };
    const state = {
        rows: [] as KVRow[],
        attention: [] as Array<{ accountId: string; key: string; state: string; resolvedBy: string | null; ownerChoice: string | null }>,
        rateCountByKey: new Map<string, number>(),
        transactionTail: Promise.resolve() as Promise<void>,
        nextId: 1,
    };
    const resetState = () => {
        state.rows = [];
        state.attention = [];
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
    const attentionItem = {
        findMany: vi.fn(async ({ where }: any) => state.attention.filter((a) => a.accountId === where.accountId && a.key.startsWith(where.key.startsWith)
            && a.state === where.state && a.resolvedBy === where.resolvedBy && a.ownerChoice === where.ownerChoice).map((a) => ({ key: a.key }))),
    };
    const dbMock = {
        ...tx,
        attentionItem,
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
        // B-922 tests: a browser login carries a login session id
        if (typeof request.headers['x-login'] === 'string') request.authLoginSessionId = request.headers['x-login'];
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

describe('B-922 main agent safety: machine tokens may only tighten', () => {
    let app: Fastify;
    const KEY = 'vh.main-agent-config.v1';
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64');
    const write = (value: unknown, version: number, human = false) => app.inject({
        method: 'POST', url: '/v1/kv', headers: { 'x-user-id': 'user-1', ...(human ? { 'x-login': 'login-1' } : {}) },
        payload: { mutations: [{ key: KEY, value: value === null ? null : typeof value === 'string' ? value : enc(value), version }] },
    });
    beforeEach(async () => { resetState(); process.env.MAX_KV_WRITES_PER_ACCOUNT_PER_MINUTE = '0'; app = await createApp(); });
    afterEach(async () => { await app.close(); delete process.env.MAX_KV_WRITES_PER_ACCOUNT_PER_MINUTE; });

    it('machine token: tightening passes, loosening is refused (preset, override, deniedTools, delete, garbage)', async () => {
        const strict = { v: 1, deniedTools: ['mcp__*__*archive*'], safety: { v: 1, preset: 'strict' } };
        expect((await write(strict, -1)).statusCode).toBe(200); // no value yet = default standard → strict is tighter
        for (const [label, next] of [
            ['preset', { ...strict, safety: { v: 1, preset: 'loose' } }],
            ['override', { ...strict, safety: { v: 1, preset: 'strict', overrides: { bash: true } } }],
            ['deniedTools removed', { ...strict, deniedTools: [] }],
            ['section dropped', { v: 1, deniedTools: strict.deniedTools }],
            ['allowedTools without a grant', { ...strict, safety: { v: 1, preset: 'strict', allowedTools: ['mcp__chat__send_message'] } }],
            ['deleted', null],
            ['not JSON', Buffer.from('%%%').toString('base64')],
        ] as const) {
            const res = await write(next, 0);
            expect(res.statusCode, label).toBe(422);
            expect(res.json(), label).toEqual({ error: 'main_agent_config_owner_only', key: KEY });
        }
        expect(state.rows[0].version).toBe(0);
        // still allowed: tighten further, non-safety edits
        expect((await write({ ...strict, skillRoots: ['~/skills'], deniedTools: ['mcp__*__*archive*', 'mcp__*__*drop*'] }, 0)).statusCode).toBe(200);
    });

    it('human (browser login) token may loosen', async () => {
        expect((await write({ v: 1, safety: { v: 1, preset: 'strict' } }, -1)).statusCode).toBe(200);
        expect((await write({ v: 1, safety: { v: 1, preset: 'loose', overrides: { bash: true } } }, 0, true)).statusCode).toBe(200);
    });

    it('machine token may add exactly the tools the owner granted "always" on a gate-1 card', async () => {
        const base = { v: 1, safety: { v: 1, preset: 'standard', allowedTools: [] as string[] } };
        expect((await write(base, -1)).statusCode).toBe(200);
        const add = (tools: string[]) => ({ v: 1, safety: { v: 1, preset: 'standard', allowedTools: tools } });
        expect((await write(add(['mcp__chat__send_message']), 0)).statusCode).toBe(422);
        state.attention.push(
            { accountId: 'user-1', key: 'main-agent-tool:0b8c2b5e-1111-4222-8333-944445555666:mcp__chat__send_message', state: 'resolved', resolvedBy: 'owner', ownerChoice: 'always' },
            { accountId: 'user-1', key: 'main-agent-tool:0b8c2b5e-1111-4222-8333-944445555667:mcp__mail__send_email', state: 'resolved', resolvedBy: 'owner', ownerChoice: 'once' },
            { accountId: 'user-1', key: 'main-agent-tool:0b8c2b5e-1111-4222-8333-944445555668:mcp__cloud__deploy', state: 'resolved', resolvedBy: 'lead', ownerChoice: 'always' },
            { accountId: 'user-2', key: 'main-agent-tool:0b8c2b5e-1111-4222-8333-944445555669:mcp__x__y', state: 'resolved', resolvedBy: 'owner', ownerChoice: 'always' },
        );
        expect((await write(add(['mcp__chat__send_message']), 0)).statusCode).toBe(200);
        for (const tool of ['mcp__mail__send_email', 'mcp__cloud__deploy', 'mcp__x__y']) {
            expect((await write(add(['mcp__chat__send_message', tool]), 1)).statusCode, tool).toBe(422);
        }
        // a grant never carries a preset change along
        expect((await write({ v: 1, safety: { v: 1, preset: 'loose', allowedTools: ['mcp__chat__send_message'] } }, 1)).statusCode).toBe(422);
    });

    it('other keys are untouched by the guard', async () => {
        expect((await write({ v: 1 }, -1)).statusCode).toBe(200);
        const res = await app.inject({ method: 'POST', url: '/v1/kv', headers: { 'x-user-id': 'user-1' }, payload: { mutations: [{ key: 'vh.main-agent.v1', value: null, version: -1 }] } });
        expect(res.statusCode).not.toBe(422);
    });
});
