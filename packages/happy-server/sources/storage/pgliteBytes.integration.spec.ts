import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { decodePrismaBytes } from './prismaBytes';

describe('PGlite bytea compatibility', () => {
    const root = mkdtempSync(join(tmpdir(), 'very-happy-pglite-bytes-'));
    const pgliteDir = join(root, 'db');
    let db: PrismaClient;

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite';
        process.env.PGLITE_DIR = pgliteDir;

        const { runMigrations } = await import('../standalone');
        await runMigrations({
            pgliteDir,
            migrationsDir: join(process.cwd(), 'prisma', 'migrations'),
        });
        ({ db } = await import('./db'));
    });

    afterAll(async () => {
        await db?.$disconnect();
        rmSync(root, { recursive: true, force: true });
    });

    it('round-trips a machine encryption key through Prisma 6 and PGlite', async () => {
        const account = await db.account.create({
            data: { publicKey: `test-${crypto.randomUUID()}` },
        });
        const expected = Buffer.from([0, 1, 127, 128, 255]);

        const machine = await db.machine.create({
            data: {
                id: crypto.randomUUID(),
                accountId: account.id,
                metadata: 'encrypted-metadata',
                dataEncryptionKey: decodePrismaBytes(expected.toString('base64')),
            },
        });

        expect(Array.from(machine.dataEncryptionKey ?? [])).toEqual(Array.from(expected));
    });
});

