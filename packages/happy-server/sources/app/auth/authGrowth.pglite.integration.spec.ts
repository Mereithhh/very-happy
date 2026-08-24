import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';

describe('auth growth bounds on PGlite', () => {
    const root = mkdtempSync(join(tmpdir(), 'very-happy-auth-growth-'));
    const pgliteDir = join(root, 'db');
    let db: PrismaClient;
    let auth: typeof import('./auth').auth;
    let createPairing: typeof import('./pairingStore').createPairing;
    let PairingCapacityError: typeof import('./pairingStore').PairingCapacityError;

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite';
        process.env.PGLITE_DIR = pgliteDir;
        process.env.HANDY_MASTER_SECRET = 'auth-growth-integration-master';

        const { runMigrations } = await import('../../standalone');
        await runMigrations({
            pgliteDir,
            migrationsDir: join(process.cwd(), 'prisma', 'migrations'),
        });
        ({ db } = await import('../../storage/db'));
        ({ auth } = await import('./auth'));
        ({ createPairing, PairingCapacityError } = await import('./pairingStore'));
        await auth.init();
    });

    afterAll(async () => {
        delete process.env.MAX_LOGIN_SESSIONS_PER_ACCOUNT;
        delete process.env.MAX_PENDING_AUTH_PAIRINGS;
        delete process.env.AUTH_PAIRING_TTL_MINUTES;
        await db?.$disconnect();
        rmSync(root, { recursive: true, force: true });
    });

    it('keeps the newest issued login token inside the active-session cap', async () => {
        process.env.MAX_LOGIN_SESSIONS_PER_ACCOUNT = '2';
        const account = await db.account.create({ data: { publicKey: `auth-growth-${crypto.randomUUID()}` } });
        const first = await auth.createLoginToken(account.id);
        const second = await auth.createLoginToken(account.id);
        const newest = await auth.createLoginToken(account.id);

        expect(await db.accountLoginSession.count({ where: { accountId: account.id } })).toBe(2);
        (auth as any).tokenCache.clear();
        await expect(auth.verifyToken(first.token)).resolves.toBeNull();
        await expect(auth.verifyToken(second.token)).resolves.toMatchObject({ userId: account.id });
        await expect(auth.verifyToken(newest.token)).resolves.toMatchObject({ userId: account.id });
    });

    it('physically removes expired rows across both pairing tables before applying one cap', async () => {
        process.env.AUTH_PAIRING_TTL_MINUTES = '10';
        process.env.MAX_PENDING_AUTH_PAIRINGS = '3';
        const expiredAt = new Date(Date.now() - 11 * 60_000);
        const terminalExpiredId = crypto.randomUUID();
        const accountExpiredId = crypto.randomUUID();
        await db.$executeRawUnsafe(
            `INSERT INTO "TerminalAuthRequest"
             ("id", "publicKey", "supportsV2", "claimSecretHash", "createdAt", "updatedAt")
             VALUES ($1, $2, true, $3, $4, $4)`,
            terminalExpiredId, 'a'.repeat(64), 'b'.repeat(64), expiredAt,
        );
        await db.$executeRawUnsafe(
            `INSERT INTO "AccountAuthRequest"
             ("id", "publicKey", "claimSecretHash", "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4, $4)`,
            accountExpiredId, 'c'.repeat(64), 'd'.repeat(64), expiredAt,
        );

        await createPairing('terminal', { publicKey: '1'.repeat(64), claimSecretHash: '2'.repeat(64), supportsV2: true });
        await createPairing('account', { publicKey: '3'.repeat(64), claimSecretHash: '4'.repeat(64) });
        await createPairing('terminal', { publicKey: '5'.repeat(64), claimSecretHash: '6'.repeat(64), supportsV2: true });
        await expect(createPairing('account', {
            publicKey: '7'.repeat(64),
            claimSecretHash: '8'.repeat(64),
        })).rejects.toBeInstanceOf(PairingCapacityError);

        expect(await db.terminalAuthRequest.count()).toBe(2);
        expect(await db.accountAuthRequest.count()).toBe(1);
        expect(await db.terminalAuthRequest.findUnique({ where: { id: terminalExpiredId } })).toBeNull();
        expect(await db.accountAuthRequest.findUnique({ where: { id: accountExpiredId } })).toBeNull();
    });
});
