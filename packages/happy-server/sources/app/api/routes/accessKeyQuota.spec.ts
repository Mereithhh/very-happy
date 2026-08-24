import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fastify } from '../types';

const { state, dbMock, resetState } = vi.hoisted(() => {
    type AccessKeyRow = {
        id: string;
        accountId: string;
        machineId: string;
        sessionId: string;
        data: string;
        dataVersion: number;
        createdAt: Date;
        updatedAt: Date;
    };
    const state = {
        sessions: [
            { id: 'session-1', accountId: 'user-1' },
            { id: 'session-2', accountId: 'user-1' },
            { id: 'foreign-session', accountId: 'user-2' },
        ],
        machines: [
            { id: 'machine-1', accountId: 'user-1' },
            { id: 'foreign-machine', accountId: 'user-2' },
        ],
        accessKeys: [] as AccessKeyRow[],
        rateCountByKey: new Map<string, number>(),
        transactionTail: Promise.resolve() as Promise<void>,
        nextId: 1,
        now: 1_700_000_000_000,
    };
    const resetState = () => {
        state.accessKeys = [];
        state.rateCountByKey = new Map();
        state.transactionTail = Promise.resolve();
        state.nextId = 1;
        state.now = 1_700_000_000_000;
    };
    const session = {
        findFirst: vi.fn(async ({ where }: any) => state.sessions.find((row) => (
            row.id === where.id && row.accountId === where.accountId
        )) ?? null),
    };
    const machine = {
        findFirst: vi.fn(async ({ where }: any) => state.machines.find((row) => (
            row.id === where.id && row.accountId === where.accountId
        )) ?? null),
    };
    const accessKey = {
        findUnique: vi.fn(async ({ where }: any) => {
            const composite = where.accountId_machineId_sessionId;
            return state.accessKeys.find((row) => composite
                ? row.accountId === composite.accountId && row.machineId === composite.machineId && row.sessionId === composite.sessionId
                : row.id === where.id) ?? null;
        }),
        create: vi.fn(async ({ data }: any) => {
            const now = new Date(state.now++);
            const row: AccessKeyRow = {
                id: `access-${state.nextId++}`,
                ...data,
                createdAt: now,
                updatedAt: now,
            };
            state.accessKeys.push(row);
            return row;
        }),
        update: vi.fn(async ({ where, data }: any) => {
            const row = state.accessKeys.find((candidate) => candidate.id === where.id);
            if (!row) throw new Error('Access key not found');
            Object.assign(row, data, { updatedAt: data.updatedAt ?? new Date(state.now++) });
            return row;
        }),
    };
    const rawQuery = vi.fn(async (sql: string, ...args: any[]) => {
        if (sql.includes('INSERT INTO "AuthRateLimitBucket"')) {
            const key = String(args[0]);
            const count = (state.rateCountByKey.get(key) ?? 0) + Number(args[3] ?? 1);
            state.rateCountByKey.set(key, count);
            return [{ count }];
        }
        if (sql.includes('FROM "Account"') && sql.includes('FOR UPDATE')) return [{ id: String(args[0]) }];
        if (sql.includes('FROM "AccessKey"')) {
            const rows = state.accessKeys.filter((row) => row.accountId === String(args[0]));
            return [{
                count: BigInt(rows.length),
                bytes: BigInt(rows.reduce((total, row) => total + Buffer.byteLength(row.data, 'utf8'), 0)),
            }];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
    });
    const tx = {
        session,
        machine,
        accessKey,
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
vi.mock('@/utils/log', () => ({ log: vi.fn() }));

import { ACCESS_KEY_DATA_MAX_DECODED_BYTES, accessKeyDataSchema } from '@/app/accessKeys/accessKeyStore';
import { accessKeysRoutes } from './accessKeysRoutes';
import { accessKeyHandler } from '../socket/accessKeyHandler';
import { AccountTerminalRateLimiter } from '../socket/terminalRateLimit';

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
    accessKeysRoutes(typed);
    await typed.ready();
    return typed;
}

function encoded(bytes: number, fill = 7): string {
    return Buffer.alloc(bytes, fill).toString('base64');
}

function createRequest(app: Fastify, sessionId = 'session-1', data = encoded(1)) {
    return app.inject({
        method: 'POST',
        url: `/v1/access-keys/${sessionId}/machine-1`,
        headers: { 'x-user-id': 'user-1' },
        payload: { data },
    });
}

describe('access-key account quotas', () => {
    let app: Fastify;
    beforeEach(async () => {
        resetState();
        process.env.MAX_ACCESS_KEY_WRITES_PER_ACCOUNT_PER_MINUTE = '0';
        delete process.env.MAX_ACCESS_KEYS_PER_ACCOUNT;
        delete process.env.MAX_ACCESS_KEY_BYTES_PER_ACCOUNT;
        app = await createApp();
    });
    afterEach(async () => {
        await app.close();
        delete process.env.MAX_ACCESS_KEY_WRITES_PER_ACCOUNT_PER_MINUTE;
        delete process.env.MAX_ACCESS_KEYS_PER_ACCOUNT;
        delete process.env.MAX_ACCESS_KEY_BYTES_PER_ACCOUNT;
    });

    it('accepts canonical base64 at exactly 4KiB and rejects malformed or oversized envelopes', async () => {
        expect(accessKeyDataSchema.safeParse(encoded(ACCESS_KEY_DATA_MAX_DECODED_BYTES)).success).toBe(true);
        expect(accessKeyDataSchema.safeParse(encoded(ACCESS_KEY_DATA_MAX_DECODED_BYTES + 1)).success).toBe(false);
        expect(accessKeyDataSchema.safeParse('not base64').success).toBe(false);

        const oversized = await createRequest(app, 'session-1', encoded(ACCESS_KEY_DATA_MAX_DECODED_BYTES + 1));
        expect(oversized.statusCode).toBe(400);
        expect(state.accessKeys).toHaveLength(0);
    });

    it('makes exact create retries idempotent but rejects a different envelope', async () => {
        const data = encoded(32);
        const [first, retry] = await Promise.all([
            createRequest(app, 'session-1', data),
            createRequest(app, 'session-1', data),
        ]);
        expect([first.statusCode, retry.statusCode]).toEqual([200, 200]);
        expect(state.accessKeys).toHaveLength(1);

        const conflict = await createRequest(app, 'session-1', encoded(32, 8));
        expect(conflict.statusCode).toBe(409);
        expect(conflict.json()).toEqual({ error: 'Access key already exists' });
    });

    it('serializes concurrent creates so only one crosses the account count boundary', async () => {
        process.env.MAX_ACCESS_KEYS_PER_ACCOUNT = '1';
        const [first, second] = await Promise.all([
            createRequest(app, 'session-1'),
            createRequest(app, 'session-2'),
        ]);
        expect(state.accessKeys).toHaveLength(1);
        expect([first.statusCode, second.statusCode].sort()).toEqual([200, 429]);
        const rejected = first.statusCode === 429 ? first : second;
        expect(rejected.json()).toEqual({ error: 'access_key_count_quota_exceeded' });
    });

    it('charges encoded create bytes and update deltas at the exact boundary', async () => {
        process.env.MAX_ACCESS_KEY_BYTES_PER_ACCOUNT = '8';
        expect((await createRequest(app, 'session-1', encoded(1))).statusCode).toBe(200); // 4 encoded bytes

        const exact = await app.inject({
            method: 'PUT',
            url: '/v1/access-keys/session-1/machine-1',
            headers: { 'x-user-id': 'user-1' },
            payload: { data: encoded(4), expectedVersion: 1 }, // 8 encoded bytes total
        });
        expect(exact.statusCode).toBe(200);

        const overflow = await app.inject({
            method: 'PUT',
            url: '/v1/access-keys/session-1/machine-1',
            headers: { 'x-user-id': 'user-1' },
            payload: { data: encoded(7), expectedVersion: 2 }, // 12 encoded bytes total
        });
        expect(overflow.statusCode).toBe(413);
        expect(overflow.json()).toEqual({ success: false, error: 'access_key_bytes_quota_exceeded' });
        expect(state.accessKeys[0].data).toBe(encoded(4));
    });

    it('shares one database-backed write rate across create and update', async () => {
        process.env.MAX_ACCESS_KEY_WRITES_PER_ACCOUNT_PER_MINUTE = '1';
        expect((await createRequest(app)).statusCode).toBe(200);
        const update = await app.inject({
            method: 'PUT',
            url: '/v1/access-keys/session-1/machine-1',
            headers: { 'x-user-id': 'user-1' },
            payload: { data: encoded(2), expectedVersion: 1 },
        });
        expect(update.statusCode).toBe(429);
        expect(update.json()).toEqual({ success: false, error: 'access_key_rate_quota_exceeded' });
    });

    it('never creates a key for a session or machine owned by another account', async () => {
        const response = await createRequest(app, 'foreign-session');
        expect(response.statusCode).toBe(404);
        expect(state.accessKeys).toHaveLength(0);
    });

    it('bounds Socket IDs and disconnects repeated reads through the shared relay allowance', async () => {
        const handlers = new Map<string, (...args: any[]) => any>();
        const socket = {
            on: vi.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)),
            emit: vi.fn(),
            disconnect: vi.fn(),
        } as any;
        const limiter = new AccountTerminalRateLimiter({
            bytesPerSecond: 0,
            burstBytes: 0,
            eventsPerSecond: 1,
            burstEvents: 1,
        });
        accessKeyHandler('user-1', socket, limiter);
        const handler = handlers.get('access-key-get')!;

        dbMock.session.findFirst.mockClear();
        const malformed = await new Promise<any>((resolve) => handler({
            sessionId: 's'.repeat(257),
            machineId: 'machine-1',
        }, resolve));
        expect(malformed.ok).toBe(false);
        expect(dbMock.session.findFirst).not.toHaveBeenCalled();

        await handler({ sessionId: 'session-1', machineId: 'machine-1' }, vi.fn());
        expect(socket.emit).toHaveBeenCalledWith('limit-reached', { resource: 'access-key-read' });
        expect(socket.disconnect).toHaveBeenCalledWith(true);
    });
});
