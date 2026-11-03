import { configuredResourceLimit } from '@/app/api/resourceLimits';
import type { Tx } from '@/storage/inTx';

/**
 * B-880 — a declared history backfill (import / fork replay of an existing
 * transcript), spec `specs/2026-11-long-import-backfill.md` PR-2.
 *
 * The account's live message budget (600/min) throttled a 12,934-message
 * import to 20 minutes (production 2026-11-03). A replay may use the separate
 * backfill budget, but only up to what the session declared before its first
 * message: a request header alone earns nothing, so an ordinary session
 * sending it is still charged to the live budget.
 *
 * Declaring is allowed once, by the owner, on a session that has no messages
 * yet and was created within BACKFILL_DECLARE_WINDOW_MS; the quota is the
 * declared total (capped per session) plus 2% headroom. Closing lowers the
 * quota to what was used, so later backfill-tagged writes go to the live
 * budget again.
 */
export const BACKFILL_DECLARE_WINDOW_MS = 5 * 60_000;
export const BACKFILL_QUOTA_HEADROOM = 0.02;

export type DeclareBackfillResult =
    | { ok: true; quota: number }
    | { ok: false; reason: 'not-found' | 'already-declared' | 'has-messages' | 'too-old' };

/** Declared total → quota: capped per session, plus 2% headroom. */
export function backfillQuotaFor(total: number): number {
    const cap = configuredResourceLimit('MAX_BACKFILL_MESSAGES_PER_SESSION', 100_000);
    const declared = cap > 0 ? Math.min(total, cap) : total;
    return Math.ceil(declared * (1 + BACKFILL_QUOTA_HEADROOM));
}

export async function declareSessionBackfill(tx: Tx, options: { accountId: string; sessionId: string; total: number; now?: number }): Promise<DeclareBackfillResult> {
    const rows = await tx.$queryRawUnsafe<Array<{ seq: number; createdAt: Date; backfillQuota: number | null }>>(
        `SELECT "seq", "createdAt", "backfillQuota" FROM "Session"
         WHERE "id" = $1 AND "accountId" = $2
         FOR UPDATE`,
        options.sessionId,
        options.accountId,
    );
    const session = rows[0];
    if (!session) return { ok: false, reason: 'not-found' };
    if (session.backfillQuota !== null) return { ok: false, reason: 'already-declared' };
    if (session.seq > 0) return { ok: false, reason: 'has-messages' };
    if ((options.now ?? Date.now()) - session.createdAt.getTime() > BACKFILL_DECLARE_WINDOW_MS) return { ok: false, reason: 'too-old' };
    const quota = backfillQuotaFor(options.total);
    await tx.$executeRawUnsafe(`UPDATE "Session" SET "backfillQuota" = $2 WHERE "id" = $1`, options.sessionId, quota);
    return { ok: true, quota };
}

/** The replay is uploaded: nothing more may use the backfill budget. False = never declared. */
export async function closeSessionBackfill(tx: Tx, options: { accountId: string; sessionId: string }): Promise<boolean> {
    const updated = await tx.$executeRawUnsafe(
        `UPDATE "Session" SET "backfillQuota" = "backfillUsed"
         WHERE "id" = $1 AND "accountId" = $2 AND "backfillQuota" IS NOT NULL`,
        options.sessionId,
        options.accountId,
    );
    return updated > 0;
}

/**
 * Charge `count` backfill-tagged messages to the session's declared quota.
 * True = within the quota (the caller then uses the backfill budget); false =
 * undeclared, closed or exhausted (the live budget).
 */
export async function chargeSessionBackfill(tx: Tx, sessionId: string, count: number): Promise<boolean> {
    const updated = await tx.$executeRawUnsafe(
        `UPDATE "Session" SET "backfillUsed" = "backfillUsed" + $2
         WHERE "id" = $1 AND "backfillQuota" IS NOT NULL AND "backfillUsed" + $2 <= "backfillQuota"`,
        sessionId,
        count,
    );
    return updated > 0;
}
