import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Fastify } from '@/app/api/types';

/**
 * Owner 10-27 (sidebar sessions drop, then come back): on a big account the
 * live sessions outside the 150 newest rows were missing from every fresh
 * page load's list. Through the real `GET /v1/sessions` route on PGlite:
 * `scope=unarchived` lists live rows older than a window full of archived
 * ones; the default list is unchanged.
 */
describe('GET /v1/sessions: the window, and scope=unarchived (pglite)', () => {
    const parent = join(homedir(), 'code/github/skills/tmp/session-list-tests');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'db-'));
    let db: PrismaClient;
    let app: Fastify;
    let accountId: string;
    let otherId: string;
    const liveOld: string[] = [];
    const archived: string[] = [];
    const liveNew: string[] = [];
    let otherLive: string;

    async function session(owner: string, at: number, archivedAt: Date | null = null) {
        const row = await db.session.create({ data: { accountId: owner, tag: randomBytes(8).toString('hex'), metadata: 'm', active: archivedAt === null, archivedAt } });
        // @updatedAt is stamped by Prisma; pin it so the window is deterministic.
        await db.$executeRaw`UPDATE "Session" SET "updatedAt" = ${new Date(at)} WHERE id = ${row.id}`;
        return row.id;
    }

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite'; process.env.PGLITE_DIR = join(root, 'db');
        process.env.HANDY_MASTER_SECRET = 'session-list-integration-test-only';
        const { runMigrations } = await import('../../standalone');
        await runMigrations({ pgliteDir: process.env.PGLITE_DIR, migrationsDir: join(process.cwd(), 'prisma/migrations') });
        ({ db } = await import('@/storage/db'));
        accountId = (await db.account.create({ data: { publicKey: randomBytes(16).toString('hex'), username: 'big' } })).id;
        otherId = (await db.account.create({ data: { publicKey: randomBytes(16).toString('hex'), username: 'other' } })).id;
        let t = Date.UTC(2026, 9, 1);
        for (let i = 0; i < 40; i++) liveOld.push(await session(accountId, t += 1000));
        for (let i = 0; i < 170; i++) archived.push(await session(accountId, t += 1000, new Date(t)));
        for (let i = 0; i < 20; i++) liveNew.push(await session(accountId, t += 1000));
        otherLive = await session(otherId, t += 1000);

        const { sessionRoutes } = await import('@/app/api/routes/sessionRoutes');
        const server = fastify();
        server.setValidatorCompiler(validatorCompiler);
        server.setSerializerCompiler(serializerCompiler);
        app = server.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
        app.decorate('authenticate', async (request: any) => { request.userId = accountId; });
        sessionRoutes(app);
        await app.ready();
    }, 120000);
    afterAll(async () => { await app?.close(); await db?.$disconnect(); rmSync(root, { recursive: true, force: true }); });

    it('the default list stays the 150 newest rows (old Web / CLI unchanged)', async () => {
        const res = await app.inject({ method: 'GET', url: '/v1/sessions' });
        expect(res.statusCode).toBe(200);
        const ids: string[] = res.json().sessions.map((s: { id: string }) => s.id);
        expect(ids.length).toBe(150);
        for (const id of [...liveNew, ...archived.slice(-130)]) expect(ids).toContain(id);
        for (const id of liveOld) expect(ids).not.toContain(id);
    });

    it('scope=unarchived returns every unarchived row — the ones outside the window too — and nothing else', async () => {
        const res = await app.inject({ method: 'GET', url: '/v1/sessions?scope=unarchived' });
        expect(res.statusCode).toBe(200);
        const ids: string[] = res.json().sessions.map((s: { id: string }) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect([...ids].sort()).toEqual([...liveOld, ...liveNew].sort());
        expect(ids).not.toContain(otherLive);
        expect((await app.inject({ method: 'GET', url: '/v1/sessions?scope=bogus' })).statusCode).toBe(400);
    });

    it('scope=unarchived past the cap: running ones first, then newest', async () => {
        const { sessionListRows } = await import('./sessionListRows');
        // The two oldest live rows are running; the rest went offline (unarchived, active=false).
        // Raw SQL: a Prisma update would restamp updatedAt.
        for (const id of [...liveOld.slice(2), ...liveNew]) await db.$executeRaw`UPDATE "Session" SET active = false WHERE id = ${id}`;
        const rows = await sessionListRows(db, accountId, { id: true }, 'unarchived', { unarchived: 10 });
        expect(rows.map((r) => r.id)).toEqual([liveOld[1], liveOld[0], ...liveNew.slice(-8).reverse()]);
    });
});
