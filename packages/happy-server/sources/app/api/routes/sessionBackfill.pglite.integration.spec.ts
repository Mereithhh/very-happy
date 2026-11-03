/**
 * B-880 PR-2: the backfill write budget is reachable only through a session's
 * declared quota — through the real routes, SQL and migrations on PGlite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PrismaClient } from '@prisma/client';
import type { Fastify } from '../types';

vi.mock('@/app/events/eventRouter', () => ({ eventRouter: { emitUpdate: vi.fn() }, buildNewMessageUpdate: vi.fn(() => ({})) }));
vi.mock('@/app/automations/attentionLifecycle', () => ({ noteSessionMessage: vi.fn() }));

describe('B-880 declared backfill quota on PGlite', () => {
    const root = mkdtempSync(join(tmpdir(), 'very-happy-backfill-'));
    const pgliteDir = join(root, 'db');
    let db: PrismaClient;
    let app: FastifyInstance;
    let accountId: string;
    let otherAccountId: string;
    let n = 0;

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite';
        process.env.PGLITE_DIR = pgliteDir;
        process.env.HANDY_MASTER_SECRET = 'backfill-integration-master';
        const { runMigrations } = await import('../../../standalone');
        await runMigrations({ pgliteDir, migrationsDir: join(process.cwd(), 'prisma', 'migrations') });
        ({ db } = await import('../../../storage/db'));
        const { v3SessionRoutes } = await import('./v3SessionRoutes');
        accountId = (await db.account.create({ data: { publicKey: 'backfill-account' } })).id;
        otherAccountId = (await db.account.create({ data: { publicKey: 'backfill-other' } })).id;
        app = fastify();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
        typed.decorate('authenticate', async (request: any) => { request.userId = request.headers['x-user-id']; });
        v3SessionRoutes(typed);
        await app.ready();
    }, 60_000);

    afterAll(async () => {
        await app?.close();
        await db?.$disconnect();
        rmSync(root, { recursive: true, force: true });
        delete process.env.MAX_MESSAGES_PER_ACCOUNT_PER_MINUTE;
        delete process.env.MAX_BACKFILL_MESSAGES_PER_ACCOUNT_PER_MINUTE;
        delete process.env.MAX_BACKFILL_MESSAGES_PER_SESSION;
    });

    beforeEach(async () => {
        process.env.MAX_MESSAGES_PER_ACCOUNT_PER_MINUTE = '2';
        process.env.MAX_BACKFILL_MESSAGES_PER_ACCOUNT_PER_MINUTE = '1000';
        delete process.env.MAX_BACKFILL_MESSAGES_PER_SESSION;
        await db.authRateLimitBucket.deleteMany({});
    });

    const session = async (owner = accountId, createdAt?: Date) =>
        (await db.session.create({ data: { tag: `t${++n}`, accountId: owner, metadata: 'x', ...(createdAt ? { createdAt } : {}) } })).id;
    const post = (sid: string, count: number, backfill: boolean, as = accountId) => app.inject({
        method: 'POST',
        url: `/v3/sessions/${sid}/messages`,
        headers: { 'x-user-id': as, ...(backfill ? { 'x-happy-message-origin': 'backfill' } : {}) },
        payload: { messages: Array.from({ length: count }, () => ({ localId: `l${++n}`, content: 'c' })) },
    });
    const declare = (sid: string, body: object, as = accountId) => app.inject({ method: 'POST', url: `/v3/sessions/${sid}/backfill`, headers: { 'x-user-id': as }, payload: body });

    it('an ordinary session sending the header is still on the live 600/min budget', async () => {
        const sid = await session();
        expect((await post(sid, 2, true)).statusCode).toBe(200);
        const over = await post(sid, 1, true);
        expect(over.statusCode).toBe(429);
        expect(over.json()).toEqual({ error: 'message_rate_quota_exceeded' });
    });

    it('a declared replay uses the backfill budget up to total + 2%, then the live one; live messages are untouched', async () => {
        const sid = await session();
        expect((await declare(sid, { total: 100 })).json()).toEqual({ quota: 102 });
        expect((await post(sid, 100, true)).statusCode).toBe(200);
        // live messages of the same account keep their whole budget meanwhile
        const live = await session();
        expect((await post(live, 2, false)).statusCode).toBe(200);
        expect((await post(sid, 2, true)).statusCode).toBe(200); // headroom
        const past = await post(sid, 1, true); // quota spent → live bucket, already full
        expect(past.json()).toEqual({ error: 'message_rate_quota_exceeded' });
        const row = await db.session.findUniqueOrThrow({ where: { id: sid }, select: { backfillQuota: true, backfillUsed: true } });
        expect(row).toEqual({ backfillQuota: 102, backfillUsed: 102 });
    });

    it('closing ends it: later backfill-tagged writes go to the live budget', async () => {
        const sid = await session();
        await declare(sid, { total: 50 });
        expect((await post(sid, 10, true)).statusCode).toBe(200);
        expect((await declare(sid, { done: true })).json()).toEqual({ closed: true });
        expect((await post(sid, 2, true)).statusCode).toBe(200);
        expect((await post(sid, 1, true)).json()).toEqual({ error: 'message_rate_quota_exceeded' });
    });

    it('declares only once, before any message, within 5 minutes, by the owner; capped per session', async () => {
        const sid = await session();
        expect((await declare(sid, { total: 10 })).statusCode).toBe(200);
        expect((await declare(sid, { total: 10 })).json()).toEqual({ error: 'backfill_not_allowed', reason: 'already-declared' });

        const used = await session();
        await post(used, 1, false);
        expect((await declare(used, { total: 10 })).json()).toEqual({ error: 'backfill_not_allowed', reason: 'has-messages' });

        const old = await session(accountId, new Date(Date.now() - 6 * 60_000));
        expect((await declare(old, { total: 10 })).json()).toEqual({ error: 'backfill_not_allowed', reason: 'too-old' });

        expect((await declare(await session(otherAccountId), { total: 10 })).statusCode).toBe(404);

        process.env.MAX_BACKFILL_MESSAGES_PER_SESSION = '1000';
        expect((await declare(await session(), { total: 9_000_000 })).json()).toEqual({ quota: 1020 });
    });

    it('the account backfill bucket still protects the database', async () => {
        process.env.MAX_BACKFILL_MESSAGES_PER_ACCOUNT_PER_MINUTE = '50';
        const sid = await session();
        await declare(sid, { total: 500 });
        expect((await post(sid, 50, true)).statusCode).toBe(200);
        const over = await post(sid, 10, true);
        expect(over.statusCode).toBe(429);
        expect(over.json()).toEqual({ error: 'message_backfill_rate_quota_exceeded' });
        // the refused batch was not charged to the session's quota (same transaction)
        expect((await db.session.findUniqueOrThrow({ where: { id: sid } })).backfillUsed).toBe(50);
    });
});
