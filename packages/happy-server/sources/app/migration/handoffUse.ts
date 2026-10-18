import type { Prisma, PrismaClient } from '@prisma/client';

type Database = PrismaClient | Prisma.TransactionClient;

/** B-627: marks a handoff nonce used; false when it was already spent. Expired rows are swept on the way. */
export async function consumeMigrationHandoffNonce(client: Database, nonce: string, expSeconds: number): Promise<boolean> {
    await client.$executeRawUnsafe('DELETE FROM "MigrationHandoffUse" WHERE "expiresAt" <= now()');
    const inserted = await client.$executeRawUnsafe(
        `INSERT INTO "MigrationHandoffUse" ("nonce", "expiresAt", "usedAt") VALUES ($1, $2, now())
         ON CONFLICT ("nonce") DO NOTHING`,
        nonce,
        new Date(expSeconds * 1000),
    );
    return inserted === 1;
}
