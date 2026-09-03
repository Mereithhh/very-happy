import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fastify } from '../types';
import { applyFakeRateLimitBucket } from '@/app/api/testing/fakeRateLimitBucket';

const { state, dbMock, resetState } = vi.hoisted(() => {
    const state = {
        items: [] as any[],
        feedSeq: 0n,
        accountSeq: 0,
        nextId: 1,
        rateCountByKey: new Map<string, number>(),
        transactionTail: Promise.resolve() as Promise<void>,
    };
    const resetState = () => {
        state.items = [];
        state.feedSeq = 0n;
        state.accountSeq = 0;
        state.nextId = 1;
        state.rateCountByKey = new Map();
        state.transactionTail = Promise.resolve();
    };
    const userFeedItem = {
        findUnique: vi.fn(async ({ where }: any) => {
            const composite = where.userId_repeatKey;
            return state.items.find((item) => item.userId === composite.userId && item.repeatKey === composite.repeatKey) ?? null;
        }),
        create: vi.fn(async ({ data }: any) => {
            const now = new Date('2026-08-24T00:00:00Z');
            const item = { id: `feed-${state.nextId++}`, ...data, createdAt: now, updatedAt: now };
            state.items.push(item);
            return item;
        }),
        update: vi.fn(async ({ where, data }: any) => {
            const item = state.items.find((candidate) => candidate.id === where.id);
            if (!item) throw new Error('Feed item not found');
            Object.assign(item, data, { updatedAt: new Date('2026-08-24T00:00:01Z') });
            return item;
        }),
        findMany: vi.fn(async () => []),
    };
    const account = {
        update: vi.fn(async ({ data }: any) => {
            if (data.feedSeq) return { feedSeq: ++state.feedSeq };
            return { seq: ++state.accountSeq };
        }),
    };
    const rawQuery = vi.fn(async (sql: string, ...args: any[]) => {
        if (sql.includes('INSERT INTO "AuthRateLimitBucket"')) {
            return applyFakeRateLimitBucket(state.rateCountByKey, args);
        }
        if (sql.includes('FROM "Account"') && sql.includes('FOR UPDATE')) return [{ id: String(args[0]) }];
        if (sql.includes('FROM "UserFeedItem"')) {
            const accountId = String(args[0]);
            const body = JSON.parse(String(args[1]));
            const repeatKey = args[2] === null ? null : String(args[2]);
            const rows = state.items.filter((item) => item.userId === accountId);
            const itemBytes = (item: any) => Buffer.byteLength(JSON.stringify(item.body), 'utf8')
                + (item.repeatKey ? Buffer.byteLength(item.repeatKey, 'utf8') : 0);
            const existing = repeatKey === null ? null : rows.find((item) => item.repeatKey === repeatKey);
            return [{
                count: BigInt(rows.length),
                bytes: BigInt(rows.reduce((total, item) => total + itemBytes(item), 0)),
                incoming_bytes: BigInt(Buffer.byteLength(JSON.stringify(body), 'utf8') + (repeatKey ? Buffer.byteLength(repeatKey, 'utf8') : 0)),
                existing_bytes: BigInt(existing ? itemBytes(existing) : 0),
            }];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
    });
    const tx = {
        userFeedItem,
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
    return { state, dbMock, resetState };
});

vi.mock('@/storage/db', () => ({ db: dbMock }));
vi.mock('@/utils/log', () => ({ log: vi.fn() }));
vi.mock('@/app/events/eventRouter', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/app/events/eventRouter')>();
    return { ...actual, eventRouter: { emitUpdate: vi.fn() } };
});

import { FEED_ENCRYPTED_BODY_MAX_BYTES } from '@/app/feed/types';
import { feedRoutes } from './feedRoutes';

async function createApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any) => { request.userId = 'account-1'; });
    feedRoutes(typed);
    await typed.ready();
    return typed;
}

function post(app: Fastify, enc = 'ciphertext', repeatKey?: string) {
    return app.inject({
        method: 'POST',
        url: '/v1/feed',
        payload: {
            notifType: 'input_needed',
            sessionId: 'session-1',
            enc,
            ...(repeatKey === undefined ? {} : { repeatKey }),
        },
    });
}

describe('feed account quotas', () => {
    let app: Fastify;
    beforeEach(async () => {
        resetState();
        process.env.MAX_FEED_WRITES_PER_ACCOUNT_PER_MINUTE = '0';
        delete process.env.MAX_FEED_ITEMS_PER_ACCOUNT;
        delete process.env.MAX_FEED_BYTES_PER_ACCOUNT;
        app = await createApp();
    });
    afterEach(async () => {
        await app.close();
        delete process.env.MAX_FEED_WRITES_PER_ACCOUNT_PER_MINUTE;
        delete process.env.MAX_FEED_ITEMS_PER_ACCOUNT;
        delete process.env.MAX_FEED_BYTES_PER_ACCOUNT;
    });

    it('rejects oversized encrypted bodies and identifiers before storage', async () => {
        expect((await post(app, 'a'.repeat(FEED_ENCRYPTED_BODY_MAX_BYTES + 1))).statusCode).toBe(400);
        expect((await app.inject({
            method: 'POST',
            url: '/v1/feed',
            payload: { notifType: 'error', sessionId: 's'.repeat(257), enc: 'x' },
        })).statusCode).toBe(400);
        expect(state.items).toHaveLength(0);
    });

    it('serializes concurrent appends at the count boundary', async () => {
        process.env.MAX_FEED_ITEMS_PER_ACCOUNT = '1';
        const [first, second] = await Promise.all([post(app, 'one'), post(app, 'two')]);
        expect([first.statusCode, second.statusCode].sort()).toEqual([200, 429]);
        expect(state.items).toHaveLength(1);
        const rejected = first.statusCode === 429 ? first : second;
        expect(rejected.json()).toEqual({ error: 'feed_count_quota_exceeded' });
    });

    it('updates a repeat key in place and charges only its stored-byte delta', async () => {
        const firstBody = { kind: 'notification', notifType: 'input_needed', sessionId: 'session-1', enc: 'a' };
        const exactBody = { ...firstBody, enc: '123456' };
        process.env.MAX_FEED_BYTES_PER_ACCOUNT = String(Buffer.byteLength(JSON.stringify(exactBody), 'utf8') + 4);
        expect((await post(app, 'a', 'same')).statusCode).toBe(200);
        expect((await post(app, '123456', 'same')).statusCode).toBe(200);
        expect(state.items).toHaveLength(1);
        expect(state.items[0].body.enc).toBe('123456');

        const overflow = await post(app, '1234567', 'same');
        expect(overflow.statusCode).toBe(413);
        expect(overflow.json()).toEqual({ error: 'feed_bytes_quota_exceeded' });
        expect(state.items[0].body.enc).toBe('123456');
    });

    it('shares one database-backed rate across null and random repeat keys', async () => {
        process.env.MAX_FEED_WRITES_PER_ACCOUNT_PER_MINUTE = '1';
        expect((await post(app, 'one')).statusCode).toBe(200);
        const limited = await post(app, 'two', 'random-key');
        expect(limited.statusCode).toBe(429);
        expect(limited.json()).toEqual({ error: 'feed_rate_quota_exceeded' });
        expect(state.items).toHaveLength(1);
    });
});
