import type { Prisma } from '@prisma/client';
import { db } from '@/storage/db';

type SqlClient = Pick<Prisma.TransactionClient, '$queryRawUnsafe' | '$executeRawUnsafe'>;

let nextCleanupAt = 0;

/**
 * Database-backed fixed-window limiter shared by every server replica.
 * The UPSERT is atomic, so concurrent requests cannot undercount a bucket.
 */
export async function allowAuthRequest(
    key: string,
    options: { max: number; windowMs: number; cost?: number },
    client: SqlClient = db,
    nowMs = Date.now(),
): Promise<boolean> {
    const cost = Number.isSafeInteger(options.cost) && (options.cost ?? 0) > 0
        ? options.cost!
        : 1;
    const now = new Date(nowMs);
    const nextReset = new Date(nowMs + options.windowMs);
    const rows = await client.$queryRawUnsafe<Array<{ count: number }>>(
        `INSERT INTO "AuthRateLimitBucket" ("key", "count", "resetAt", "updatedAt")
         VALUES ($1, $4, $2, $3)
         ON CONFLICT ("key") DO UPDATE SET
           "count" = CASE
             WHEN "AuthRateLimitBucket"."resetAt" <= $3 THEN $4
             ELSE "AuthRateLimitBucket"."count" + $4
           END,
           "resetAt" = CASE
             WHEN "AuthRateLimitBucket"."resetAt" <= $3 THEN $2
             ELSE "AuthRateLimitBucket"."resetAt"
           END,
           "updatedAt" = $3
         RETURNING "count"`,
        key,
        nextReset,
        now,
        cost,
    );

    // Opportunistic bounded cleanup; correctness never depends on it.
    // Interactive transaction clients (notably PGlite's single connection)
    // must not start an unawaited second query on the same transaction.
    if (client === db && nowMs >= nextCleanupAt) {
        nextCleanupAt = nowMs + 60_000;
        void client.$executeRawUnsafe(
            'DELETE FROM "AuthRateLimitBucket" WHERE "resetAt" <= $1',
            now,
        ).catch(() => undefined);
    }
    return (rows[0]?.count ?? options.max + 1) <= options.max;
}

export function resetAuthRateLimiterCleanupForTests(): void {
    nextCleanupAt = 0;
}
