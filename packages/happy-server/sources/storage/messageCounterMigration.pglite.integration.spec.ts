import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

describe('account message counter migration upgrade', () => {
    const root = mkdtempSync(join(tmpdir(), 'very-happy-message-counter-upgrade-'));
    const pgliteDir = join(root, 'db');
    const oldMigrationsDir = join(root, 'old-migrations');
    const currentMigrationsDir = join(process.cwd(), 'prisma', 'migrations');

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite';
        process.env.PGLITE_DIR = pgliteDir;
        cpSync(currentMigrationsDir, oldMigrationsDir, { recursive: true });
        rmSync(join(oldMigrationsDir, '20260825001000_install_account_message_counter_trigger'), {
            recursive: true,
            force: true,
        });

        const { runMigrations } = await import('../standalone');
        await runMigrations({ pgliteDir, migrationsDir: oldMigrationsDir });

        const oldDatabase = new PGlite(pgliteDir);
        await oldDatabase.query(
            `INSERT INTO "Account"
             ("id", "publicKey", "messageCount", "messageBytes", "createdAt", "updatedAt")
             VALUES ($1, $2, 9, 99, now(), now())`,
            ['stale-account', 'stale-account-public-key'],
        );
        await oldDatabase.close();

        await runMigrations({ pgliteDir, migrationsDir: currentMigrationsDir });
    });

    afterAll(() => {
        delete process.env.DB_PROVIDER;
        delete process.env.PGLITE_DIR;
        rmSync(root, { recursive: true, force: true });
    });

    it('repairs stale counters for an account whose last session was deleted by an old binary', async () => {
        const upgraded = new PGlite(pgliteDir);
        const counters = await upgraded.query<{ messageCount: number; messageBytes: number }>(
            `SELECT "messageCount", "messageBytes" FROM "Account" WHERE "id" = $1`,
            ['stale-account'],
        );
        const triggers = await upgraded.query<{ count: number }>(
            `SELECT COUNT(*)::integer AS count
             FROM pg_trigger
             WHERE tgname = 'account_message_counters' AND NOT tgisinternal`,
        );
        await upgraded.close();

        expect(counters.rows).toEqual([{ messageCount: 0, messageBytes: 0 }]);
        expect(triggers.rows).toEqual([{ count: 1 }]);
    });
});
