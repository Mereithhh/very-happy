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

const REFUSED = Symbol('auth-rate-refused');

/**
 * All-or-nothing over several windows (e.g. per hour AND per day). Calling
 * `allowAuthRequest` once per window charges the earlier windows before a
 * later one refuses, so a client retrying against a full hourly bucket drains
 * its daily one with requests that were all refused (B-836 QA16: 5 accepted +
 * 15 refused left day=20, and the account was locked out for the day).
 *
 * Every charge runs in one transaction and a refusal rolls them all back. Each
 * UPSERT holds its row lock until commit, so a concurrent caller waits on the
 * first shared bucket and then re-checks against the committed count — it can
 * neither overspend nor observe a charge that is about to be rolled back.
 * Callers must list buckets in a fixed order so two of them cannot deadlock.
 */
export async function allowAuthRequests(
    buckets: ReadonlyArray<{ key: string; max: number; windowMs: number; cost?: number }>,
    nowMs = Date.now(),
): Promise<boolean> {
    try {
        await db.$transaction(async (tx) => {
            for (const bucket of buckets) {
                const allowed = await allowAuthRequest(bucket.key, bucket, tx, nowMs);
                if (!allowed) throw REFUSED;
            }
        });
        return true;
    } catch (error) {
        if (error === REFUSED) return false;
        throw error;
    }
}

export interface AuthRateBucket {
    key: string;
    max: number;
    windowMs?: number;
    cost?: number;
}

/**
 * B-668: seconds until a refused request could succeed. Every bucket that
 * cannot take another `cost` blocks the retry, so the answer is the LATEST
 * reset among them — not the first bucket the sequential consumer happened to
 * stop on. A refused call never opens or charges a row, so a bucket with no
 * live row is not blocking. Rounds up and never answers below one second: a
 * refusal raced by a window reset still tells the client to back off briefly.
 */
export function retryAfterSecondsForBuckets(
    buckets: ReadonlyArray<AuthRateBucket>,
    rows: ReadonlyArray<{ key: string; count: number | bigint; resetAt: Date | string }>,
    nowMs: number,
): number {
    const byKey = new Map(rows.map((row) => [row.key, row]));
    let longestMs = 0;
    for (const bucket of buckets) {
        const row = byKey.get(bucket.key);
        if (!row) continue;
        const remainingMs = new Date(row.resetAt).getTime() - nowMs;
        if (!(remainingMs > 0)) continue;
        const cost = Number.isSafeInteger(bucket.cost) && (bucket.cost ?? 0) > 0 ? bucket.cost! : 1;
        if (Number(row.count) + cost <= bucket.max) continue;
        longestMs = Math.max(longestMs, remainingMs);
    }
    return Math.max(1, Math.ceil(longestMs / 1000));
}

export async function authRateLimitRetryAfterSeconds(
    buckets: ReadonlyArray<AuthRateBucket>,
    client: Pick<SqlClient, '$queryRawUnsafe'> = db,
    nowMs = Date.now(),
): Promise<number> {
    if (buckets.length === 0) return 1;
    const placeholders = buckets.map((_, index) => `$${index + 2}`).join(', ');
    const rows = await client.$queryRawUnsafe<Array<{ key: string; count: number; resetAt: Date }>>(
        `SELECT "key", "count", "resetAt" FROM "AuthRateLimitBucket"
         WHERE "resetAt" > $1 AND "key" IN (${placeholders})`,
        new Date(nowMs),
        ...buckets.map((bucket) => bucket.key),
    );
    return retryAfterSecondsForBuckets(buckets, rows, nowMs);
}

export function resetAuthRateLimiterCleanupForTests(): void {
    nextCleanupAt = 0;
}
