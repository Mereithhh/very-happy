import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fastify } from '../types';

const { state, dbMock, resetState } = vi.hoisted(() => {
    type Row = { id: string; accountId: string; token: string; createdAt: Date; updatedAt: Date };
    const state = {
        rows: [] as Row[],
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
    const accountPushToken = {
        findUnique: vi.fn(async ({ where }: any) => {
            const key = where.accountId_token;
            return state.rows.find((row) => row.accountId === key.accountId && row.token === key.token) ?? null;
        }),
        count: vi.fn(async ({ where }: any) => state.rows.filter((row) => row.accountId === where.accountId).length),
        update: vi.fn(async ({ where, data }: any) => {
            const row = state.rows.find((item) => item.id === where.id)!;
            Object.assign(row, data);
            return row;
        }),
        create: vi.fn(async ({ data }: any) => {
            const now = new Date();
            const row: Row = { id: `push-${state.nextId++}`, ...data, createdAt: now, updatedAt: now };
            state.rows.push(row);
            return row;
        }),
        deleteMany: vi.fn(async ({ where }: any) => {
            const before = state.rows.length;
            state.rows = state.rows.filter((row) => !(row.accountId === where.accountId && (
                where.token === undefined || row.token === where.token || (where.token.startsWith && row.token.startsWith(where.token.startsWith))
            )));
            return { count: before - state.rows.length };
        }),
        findMany: vi.fn(async () => []),
    };
    const rawQuery = vi.fn(async (sql: string, ...args: any[]) => {
        if (sql.includes('INSERT INTO "AuthRateLimitBucket"')) {
            const key = String(args[0]);
            const count = (state.rateCountByKey.get(key) ?? 0) + Number(args[3] ?? 1);
            state.rateCountByKey.set(key, count);
            return [{ count }];
        }
        if (sql.includes('FROM "Account"') && sql.includes('FOR UPDATE')) return [{ id: String(args[0]) }];
        throw new Error(`Unexpected SQL: ${sql}`);
    });
    const tx = { accountPushToken, $queryRawUnsafe: rawQuery, $executeRawUnsafe: vi.fn(async () => 0) };
    const dbMock = {
        ...tx,
        session: { findFirst: vi.fn(async () => null) },
        $transaction: vi.fn(async (fn: any) => {
            if (Array.isArray(fn)) return Promise.all(fn);
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
vi.mock('@/app/push/pushDispatch', () => ({ dispatchSessionEventPush: vi.fn(), dispatchDeviceEventPush: vi.fn() }));
vi.mock('@/app/push/webPush', () => ({ getVapidPublicKey: () => null, webPushConfigured: () => false }));
vi.mock('@/app/events/eventRouter', () => ({ eventRouter: { emitEphemeral: vi.fn() }, buildSessionEventEphemeral: () => ({}) }));
vi.mock('@/utils/log', () => ({ log: vi.fn() }));

import { PUSH_TOKEN_MAX_BYTES, pushRoutes, pushTokenSchema } from './pushRoutes';

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
    pushRoutes(typed);
    await typed.ready();
    return typed;
}

function register(app: Fastify, token: string) {
    return app.inject({ method: 'POST', url: '/v1/push-tokens', headers: { 'x-user-id': 'user-1' }, payload: { token } });
}

describe('push token account quota', () => {
    let app: Fastify;
    beforeEach(async () => {
        resetState();
        process.env.MAX_PUSH_TOKEN_WRITES_PER_ACCOUNT_PER_MINUTE = '0';
        delete process.env.MAX_PUSH_TOKENS_PER_ACCOUNT;
        app = await createApp();
    });
    afterEach(async () => {
        await app.close();
        delete process.env.MAX_PUSH_TOKEN_WRITES_PER_ACCOUNT_PER_MINUTE;
        delete process.env.MAX_PUSH_TOKENS_PER_ACCOUNT;
    });

    it('enforces the UTF-8 token byte boundary', async () => {
        const exact = 'x'.repeat(PUSH_TOKEN_MAX_BYTES);
        expect(pushTokenSchema.safeParse(exact).success).toBe(true);
        expect(pushTokenSchema.safeParse(`${exact}x`).success).toBe(false);
        expect((await register(app, exact)).statusCode).toBe(200);
        expect((await register(app, `${exact}x`)).statusCode).toBe(400);
    });

    it('keeps existing tokens idempotent but rejects a new token at the count cap', async () => {
        process.env.MAX_PUSH_TOKENS_PER_ACCOUNT = '1';
        expect((await register(app, 'token-a')).statusCode).toBe(200);
        expect((await register(app, 'token-a')).statusCode).toBe(200);
        const rejected = await register(app, 'token-b');
        expect(rejected.statusCode).toBe(429);
        expect(rejected.json()).toEqual({ error: 'push_token_count_quota_exceeded' });
        expect(state.rows).toHaveLength(1);
    });

    it('atomically permits one of two concurrent unique tokens', async () => {
        process.env.MAX_PUSH_TOKENS_PER_ACCOUNT = '1';
        const [left, right] = await Promise.all([register(app, 'left'), register(app, 'right')]);
        expect([left.statusCode, right.statusCode].sort()).toEqual([200, 429]);
        expect(state.rows).toHaveLength(1);
    });

    it('returns a stable database-backed rate error', async () => {
        process.env.MAX_PUSH_TOKEN_WRITES_PER_ACCOUNT_PER_MINUTE = '1';
        expect((await register(app, 'first')).statusCode).toBe(200);
        const second = await register(app, 'second');
        expect(second.statusCode).toBe(429);
        expect(second.json()).toEqual({ error: 'push_token_rate_quota_exceeded' });
    });
});
