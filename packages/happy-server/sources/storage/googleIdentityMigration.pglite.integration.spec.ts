import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

describe('Google identity unique-index migration upgrade', () => {
    const roots: string[] = [];
    const currentMigrationsDir = join(process.cwd(), 'prisma', 'migrations');

    afterAll(() => {
        for (const root of roots) rmSync(root, { recursive: true, force: true });
    });

    async function prepare(identitySubjects: string[]) {
        const root = mkdtempSync(join(tmpdir(), 'very-happy-google-identity-upgrade-'));
        roots.push(root);
        const pgliteDir = join(root, 'db');
        const oldMigrationsDir = join(root, 'old-migrations');
        cpSync(currentMigrationsDir, oldMigrationsDir, { recursive: true });
        rmSync(join(oldMigrationsDir, '20260825190000_unique_google_identity_per_account'), {
            recursive: true,
            force: true,
        });
        const { runMigrations } = await import('../standalone');
        await runMigrations({ pgliteDir, migrationsDir: oldMigrationsDir });
        const oldDatabase = new PGlite(pgliteDir);
        await oldDatabase.query(
            `INSERT INTO "Account" ("id", "publicKey", "createdAt", "updatedAt")
             VALUES ('account-with-google', 'migration-public-key', now(), now())`,
        );
        for (const [index, subject] of identitySubjects.entries()) {
            await oldDatabase.query(
                `INSERT INTO "AccountIdentity"
                 ("id", "accountId", "provider", "providerSubject", "updatedAt")
                 VALUES ($1, 'account-with-google', 'google', $2, now())`,
                [`google-identity-${index}`, subject],
            );
        }
        await oldDatabase.close();
        return { pgliteDir, runMigrations };
    }

    it('upgrades a historical account with one Google identity', async () => {
        const { pgliteDir, runMigrations } = await prepare(['google-subject-1']);
        await expect(runMigrations({ pgliteDir, migrationsDir: currentMigrationsDir })).resolves.toBeUndefined();
        const upgraded = new PGlite(pgliteDir);
        const indexes = await upgraded.query<{ count: number }>(
            `SELECT COUNT(*)::integer AS count FROM pg_indexes
             WHERE indexname = 'AccountIdentity_one_google_per_account'`,
        );
        await upgraded.close();
        expect(indexes.rows).toEqual([{ count: 1 }]);
    }, 20_000);

    it('fails closed when historical ownership has more than one Google identity', async () => {
        const { pgliteDir, runMigrations } = await prepare(['google-subject-1', 'google-subject-2']);
        await expect(runMigrations({ pgliteDir, migrationsDir: currentMigrationsDir }))
            .rejects.toThrow(/duplicate Google identities per account/i);
    }, 20_000);
});
