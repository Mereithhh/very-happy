import { db } from '@/storage/db';
import type { Tx } from '@/storage/inTx';
import { log } from '@/utils/log';

/**
 * B-944: lifetime of a scoped team credential (`x-happy-team-token`). Issued for 30 days;
 * a live, unrevoked credential is slid back to 30 days by a successful scoped request once
 * fewer than 7 days remain. Renewing resets the remainder to 30 days, so the next renewal
 * is ≥ 23 days away: at most one write per credential per day, with no extra column.
 */
export const TEAM_CREDENTIAL_TTL_MS = 30 * 86400_000;
export const TEAM_CREDENTIAL_RENEW_BELOW_MS = 7 * 86400_000;
/** Root (Lead) credentials of a live session with fewer than this left raise `VeryHappyTeamRootCredentialExpiring`. */
export const TEAM_CREDENTIAL_ALERT_BELOW_MS = 7 * 86400_000;

export function teamCredentialNeedsRenewal(expiresAt: Date, now: number): boolean {
    return expiresAt.getTime() - now < TEAM_CREDENTIAL_RENEW_BELOW_MS;
}

/**
 * Called inside the request transaction after the token resolved, so a request that fails
 * afterwards (stale agent, refused action) rolls the renewal back. The WHERE re-checks
 * revocation and the threshold: a concurrent revoke or renewal wins and this writes nothing.
 */
export async function renewTeamCredentialTx(tx: Tx, credential: { id: string; teamId: string; botId: string; generation: number; expiresAt: Date }, now = Date.now()): Promise<boolean> {
    if (!teamCredentialNeedsRenewal(credential.expiresAt, now)) return false;
    const expiresAt = new Date(now + TEAM_CREDENTIAL_TTL_MS);
    const updated = await tx.$executeRaw`UPDATE "TeamAgentCredential" SET "expiresAt"=${expiresAt} WHERE "id"=${credential.id} AND "revokedAt" IS NULL AND "expiresAt">now() AND "expiresAt"<${new Date(now + TEAM_CREDENTIAL_RENEW_BELOW_MS)}`;
    if (updated === 1) log({ module: 'teams', teamId: credential.teamId, botId: credential.botId, generation: credential.generation, previousExpiresAt: credential.expiresAt.toISOString(), expiresAt: expiresAt.toISOString() }, 'team credential renewed');
    return updated === 1;
}

/**
 * B-944: current-generation, unrevoked credentials of root members whose session is still
 * active, in live (unarchived) teams — `expiring` has < 7 days left, `expired` is already
 * past (every team tool of that Lead answers 401 `invalid_team_token`; see docs/operations.md
 * "Team credential expired"). Abandoned teams (session inactive) are not counted.
 */
export async function rootTeamCredentialHealth(client: Pick<typeof db, '$queryRaw'> = db, now = Date.now()): Promise<{ expiring: number; expired: number }> {
    const alertBefore = new Date(now + TEAM_CREDENTIAL_ALERT_BELOW_MS);
    const rows = await client.$queryRaw<{ expiring: bigint; expired: bigint }[]>`
        SELECT count(*) FILTER (WHERE c."expiresAt">now() AND c."expiresAt"<${alertBefore}) AS "expiring",
               count(*) FILTER (WHERE c."expiresAt"<=now()) AS "expired"
        FROM "TeamAgentCredential" c
        JOIN "AgentTeam" t ON t."id"=c."teamId"
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t."state"->'bots', '[]'::jsonb)) b
        JOIN "Session" s ON s."id"=b->>'sessionId' AND s."accountId"=t."accountId"
        WHERE c."revokedAt" IS NULL AND t."state"->>'archivedAt' IS NULL AND s."active"=true
          AND b->>'id'=c."botId" AND (b->>'root')::boolean AND (b->>'generation')::int=c."generation"`;
    return { expiring: Number(rows[0]?.expiring ?? 0), expired: Number(rows[0]?.expired ?? 0) };
}
