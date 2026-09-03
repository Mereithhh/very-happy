import type { Prisma } from '@prisma/client';
import { db } from '@/storage/db';

type SqlClient = Pick<Prisma.TransactionClient, '$queryRawUnsafe' | '$executeRawUnsafe'>;

let nextCleanupAt = 0;

/**
 * Database-backed fixed-window limiter shared by every server replica.
 * The UPSERT is atomic, so concurrent requests cannot undercount a bucket.
 *
 * B-307: a REJECTED request must not consume budget. The original UPSERT added
 * the cost unconditionally and only then compared, so a client retrying against
 * a full bucket kept paying into it — and since every client in this codebase
 * retries (`utils/time.ts` backoff never gives up), a single stuck session could
 * spend the whole account's next window on requests that were all refused. That
 * is how one write conflict turned into an hour in which no session could be
 * created at all. Now the DO UPDATE carries a WHERE: if the cost does not fit,
 * no row is updated, nothing is charged, and the refusal is the empty result.
 *
 * The `$5` guard is what makes this safe under concurrency — it is evaluated
 * inside the same atomic UPSERT as the increment, not read-then-write.
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
    // A single request costlier than the whole window can never fit. Refuse it
    // without opening a bucket, so it cannot lock out cheaper callers either.
    if (cost > options.max) return false;
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
         WHERE "AuthRateLimitBucket"."resetAt" <= $3
            OR "AuthRateLimitBucket"."count" + $4 <= $5
         RETURNING "count"`,
        key,
        nextReset,
        now,
        cost,
        options.max,
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
    // No row came back ⇒ the DO UPDATE's WHERE refused it ⇒ nothing was charged.
    // `count <= max` is NOT a valid test any more: a refused cost-5 request
    // leaves a count of 598 against a max of 600, and the next cost-1 request
    // legitimately fits.
    return rows.length > 0;
}

export function resetAuthRateLimiterCleanupForTests(): void {
    nextCleanupAt = 0;
}
