import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import type { Fastify } from '../types';

/**
 * B-627 on PGlite: one process plays both relays. The source routes decide who
 * sees the banner and mint tickets; the destination route spends them.
 */
describe('B-627 relay migration routes (pglite)', () => {
    const parent = join(homedir(), 'code/github/skills/tmp/vh-migration-tests');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'db-'));
    const secret = 'migration-handoff-secret-for-tests-0123456789';
    let db: PrismaClient;
    let app: FastifyInstance;
    let requestUserId = '';
    let targetedById = '';
    let targetedByDomain = '';
    let outsider = '';
    let auth: typeof import('@/app/auth/auth').auth;
    let notices: typeof import('@/app/migration/daemonNotice');

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite'; process.env.PGLITE_DIR = join(root, 'db');
        process.env.HANDY_MASTER_SECRET = 'migration-routes-integration-test-only';
        process.env.MIGRATION_HANDOFF_SECRET = secret;
        process.env.MIGRATION_TARGET_URL = 'https://api.new.test';
        process.env.MIGRATION_TARGET_WEBAPP_URL = 'https://new.test';
        process.env.MIGRATION_TARGET_NAME = 'New Relay';
        process.env.MIGRATION_EMAIL_DOMAINS = 'apodex.com';
        const { runMigrations } = await import('../../../standalone');
        await runMigrations({ pgliteDir: process.env.PGLITE_DIR, migrationsDir: join(process.cwd(), 'prisma/migrations') });
        await (await import('@/modules/encrypt')).initEncrypt();
        ({ auth } = await import('@/app/auth/auth'));
        await auth.init();
        ({ db } = await import('@/storage/db'));
        notices = await import('@/app/migration/daemonNotice');
        notices.resetMigrationConfigCache();
        const { upsertAccountSecret } = await import('@/app/auth/accountSecrets');

        targetedById = (await db.account.create({ data: { publicKey: 'pk-by-id' } })).id;
        await upsertAccountSecret(db, targetedById, Buffer.alloc(32, 1).toString('base64url'));
        targetedByDomain = (await db.account.create({ data: { publicKey: 'pk-by-domain' } })).id;
        await db.accountIdentity.create({ data: { accountId: targetedByDomain, provider: 'google', providerSubject: 'g-1', email: 'Someone@Apodex.com' } });
        await upsertAccountSecret(db, targetedByDomain, Buffer.alloc(32, 2).toString('base64url'));
        await db.machine.create({ data: { id: 'machine-domain', accountId: targetedByDomain, metadata: '', metadataVersion: 1, daemonState: '', daemonStateVersion: 1, seq: 0 } });
        outsider = (await db.account.create({ data: { publicKey: 'pk-outsider' } })).id;
        await db.accountIdentity.create({ data: { accountId: outsider, provider: 'email', providerSubject: 'x@gmail.com', email: 'x@gmail.com' } });
        process.env.MIGRATION_ACCOUNT_IDS = targetedById;
        notices.resetMigrationConfigCache();

        const { migrationRoutes } = await import('./migrationRoutes');
        app = fastify();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
        typed.decorate('authenticate', async (request: any) => { request.userId = requestUserId; });
        migrationRoutes(typed);
        await app.ready();
    }, 60_000);

    afterAll(async () => {
        await app?.close();
        await db?.$disconnect();
        rmSync(root, { recursive: true, force: true });
    });

    function as(userId: string) { requestUserId = userId; }

    it('shows the banner only to targeted accounts (by id or verified email domain) and mints a ticket for them', async () => {
        as(outsider);
        expect((await app.inject({ method: 'GET', url: '/v1/migration' })).json()).toEqual({ target: null });
        expect((await app.inject({ method: 'POST', url: '/v1/migration/handoff' })).statusCode).toBe(403);
        as(targetedById);
        expect((await app.inject({ method: 'GET', url: '/v1/migration' })).json()).toEqual({ target: { url: 'https://new.test', name: 'New Relay' } });
        as(targetedByDomain);
        const minted = await app.inject({ method: 'POST', url: '/v1/migration/handoff' });
        expect(minted.statusCode).toBe(200);
        expect(minted.headers['cache-control']).toBe('no-store');
        const url = new URL(minted.json().url);
        expect(`${url.origin}${url.pathname}`).toBe('https://new.test/login/migrate');
        expect(url.searchParams.get('handoff')).toMatch(/^vh1\./);
    });

    it('spends a web ticket once for the token + account secret, and refuses forgeries and unknown accounts', async () => {
        as(targetedByDomain);
        const handoff = new URL((await app.inject({ method: 'POST', url: '/v1/migration/handoff' })).json().url).searchParams.get('handoff')!;
        const complete = await app.inject({ method: 'POST', url: '/v1/auth/migrate/complete', payload: { handoff } });
        expect(complete.statusCode).toBe(200);
        expect(complete.json()).toMatchObject({ kind: 'web', secret: Buffer.alloc(32, 2).toString('base64url') });
        expect(await auth.verifyToken(complete.json().token)).toMatchObject({ userId: targetedByDomain });
        expect(await db.migrationHandoffUse.count()).toBe(1);
        // Replay is dead.
        expect((await app.inject({ method: 'POST', url: '/v1/auth/migrate/complete', payload: { handoff } })).json()).toEqual({ error: 'invalid_handoff' });
        // Tampered signature.
        expect((await app.inject({ method: 'POST', url: '/v1/auth/migrate/complete', payload: { handoff: handoff.slice(0, -2) + 'zz' } })).statusCode).toBe(401);
        // A ticket for an account this relay never received.
        const { issueMigrationHandoff } = await import('@/app/migration/handoff');
        const ghost = issueMigrationHandoff(secret, { kind: 'web', accountId: 'never-copied' });
        expect((await app.inject({ method: 'POST', url: '/v1/auth/migrate/complete', payload: { handoff: ghost } })).json()).toEqual({ error: 'account_missing' });
    });

    it('tells a targeted daemon where to go on connect, and the daemon ticket buys a machine token on the new relay', async () => {
        const emit = vi.fn();
        await notices.emitServerMigrateIfTargeted({ emit } as any, outsider, 'machine-x');
        expect(emit).not.toHaveBeenCalled();
        await notices.emitServerMigrateIfTargeted({ emit } as any, targetedByDomain, 'machine-domain');
        expect(emit).toHaveBeenCalledOnce();
        const [event, notice] = emit.mock.calls[0];
        expect(event).toBe('server-migrate');
        expect(notice).toMatchObject({ url: 'https://api.new.test', webappUrl: 'https://new.test' });
        const { ServerMigrateNoticeSchema } = await import('@slopus/happy-wire');
        expect(ServerMigrateNoticeSchema.safeParse(notice).success).toBe(true);

        const complete = await app.inject({ method: 'POST', url: '/v1/auth/migrate/complete', payload: { handoff: notice.handoff } });
        expect(complete.statusCode).toBe(200);
        expect(complete.json()).toEqual({ kind: 'daemon', token: expect.any(String) });
        expect(await auth.verifyToken(complete.json().token)).toMatchObject({ userId: targetedByDomain });

        // A daemon ticket whose machine belongs to someone else on this relay is refused.
        const { issueMigrationHandoff } = await import('@/app/migration/handoff');
        const stolen = issueMigrationHandoff(secret, { kind: 'daemon', accountId: outsider, machineId: 'machine-domain' });
        expect((await app.inject({ method: 'POST', url: '/v1/auth/migrate/complete', payload: { handoff: stolen } })).json()).toEqual({ error: 'invalid_handoff' });
    });
});
