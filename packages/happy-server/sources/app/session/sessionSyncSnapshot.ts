/**
 * B-811 (B-807 spec §4.2–4.3): the snapshot read behind `sync-hello` and
 * `session-subscribe`.
 *
 * Correctness rests on ONE statement: `Session.seq` (the head) and the
 * messages come from the same READ COMMITTED statement snapshot, so a message
 * is either visible in it together with the head that counts it, or it commits
 * after the snapshot began — and then its post-commit `update/new-message`
 * emit reaches the caller, which joined its user-scoped room before the read.
 * Reading head and messages in two statements would let a commit land between
 * them (head ≠ page), so never split this query. No transaction is opened,
 * which keeps it pgbouncer transaction-pooling friendly.
 */
import type { SyncMessage, SyncSubResultOk } from '@slopus/happy-wire';

export interface SnapshotClient {
    $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export interface SessionHead {
    seq: number;
    accountId: string;
}

/** One primary-key statement for every hello sub (≤ 16 ids). */
export async function readSessionHeads(client: SnapshotClient, sessionIds: string[]): Promise<Map<string, SessionHead>> {
    const heads = new Map<string, SessionHead>();
    if (sessionIds.length === 0) return heads;
    const rows = await client.$queryRawUnsafe<Array<{ id: string; seq: number; accountId: string }>>(
        `SELECT "id", "seq", "accountId" FROM "Session" WHERE "id" = ANY($1::text[])`,
        sessionIds,
    );
    for (const row of rows) heads.set(row.id, { seq: Number(row.seq), accountId: row.accountId });
    return heads;
}

export type SnapshotPlan =
    /** Head says nothing is past afterSeq: answer from the head read alone. */
    | { kind: 'none' }
    | { kind: 'increment' }
    /** Cold (afterSeq null) or gapTooLarge: the latest page. */
    | { kind: 'latest'; gapTooLarge: boolean };

/** §4.3. `head` is the batch head; the snapshot re-reads it. */
export function planSnapshot(head: number, afterSeq: number | null, gapThreshold: number): SnapshotPlan {
    if (afterSeq === null) return head === 0 ? { kind: 'none' } : { kind: 'latest', gapTooLarge: false };
    if (head <= afterSeq) return { kind: 'none' };
    if (head - afterSeq > gapThreshold) return { kind: 'latest', gapTooLarge: true };
    return { kind: 'increment' };
}

type SnapshotRow = {
    head: number;
    id: string | null;
    seq: number | null;
    content: unknown;
    localId: string | null;
    createdAt: Date | string | null;
    updatedAt: Date | string | null;
};

const INCREMENT_SQL = `
WITH h AS (SELECT "seq" AS head FROM "Session" WHERE "id" = $1)
SELECT h.head, m."id", m."seq", m."content", m."localId", m."createdAt", m."updatedAt"
FROM h LEFT JOIN LATERAL (
    SELECT "id", "seq", "content", "localId", "createdAt", "updatedAt"
    FROM "SessionMessage"
    WHERE "sessionId" = $1 AND "seq" > $2
    ORDER BY "seq" ASC LIMIT $3
) m ON true`;

const LATEST_SQL = `
WITH h AS (SELECT "seq" AS head FROM "Session" WHERE "id" = $1)
SELECT h.head, m."id", m."seq", m."content", m."localId", m."createdAt", m."updatedAt"
FROM h LEFT JOIN LATERAL (
    SELECT "id", "seq", "content", "localId", "createdAt", "updatedAt"
    FROM "SessionMessage"
    WHERE "sessionId" = $1
    ORDER BY "seq" DESC LIMIT $2
) m ON true`;

function toMillis(value: Date | string): number {
    return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/** Same fields and encoding as REST `toResponseMessage` (v3SessionRoutes). */
function toSyncMessage(row: SnapshotRow): SyncMessage {
    return {
        id: row.id!,
        seq: Number(row.seq),
        content: row.content,
        localId: row.localId,
        createdAt: toMillis(row.createdAt!),
        updatedAt: toMillis(row.updatedAt!),
    };
}

export interface SessionSnapshot {
    head: number;
    /** seq ascending. */
    messages: SyncMessage[];
    hasMore: boolean;
}

/**
 * The §4.2 single-statement read. `null` = the session row is gone (deleted
 * between the auth check and this read). Increments fetch limit+1 rows to
 * learn hasMore; the latest page has nothing further forward by definition.
 */
export async function readSessionSnapshot(
    client: SnapshotClient,
    params: { sessionId: string; afterSeq: number; limit: number } | { sessionId: string; afterSeq: null; limit: number },
): Promise<SessionSnapshot | null> {
    const rows = params.afterSeq === null
        ? await client.$queryRawUnsafe<SnapshotRow[]>(LATEST_SQL, params.sessionId, params.limit)
        : await client.$queryRawUnsafe<SnapshotRow[]>(INCREMENT_SQL, params.sessionId, params.afterSeq, params.limit + 1);
    if (rows.length === 0) return null;
    const head = Number(rows[0].head);
    const messages = rows.filter((row) => row.id !== null).map(toSyncMessage);
    if (params.afterSeq === null) {
        messages.reverse();
        return { head, messages, hasMore: false };
    }
    const hasMore = messages.length > params.limit;
    return { head, messages: hasMore ? messages.slice(0, params.limit) : messages, hasMore };
}

/** Shape a snapshot into the wire result (spec §3.3). */
export function buildSubResult(sid: string, plan: SnapshotPlan, head: number, snapshot: SessionSnapshot | null): SyncSubResultOk {
    if (plan.kind === 'none' || !snapshot) {
        return { sid, ok: true, headSeq: head, messages: [], hasMore: false };
    }
    if (plan.kind === 'increment') {
        return { sid, ok: true, headSeq: snapshot.head, messages: snapshot.messages, hasMore: snapshot.hasMore };
    }
    const result: SyncSubResultOk = { sid, ok: true, headSeq: snapshot.head, messages: snapshot.messages, hasMore: false };
    if (plan.gapTooLarge) result.gapTooLarge = true;
    if (snapshot.messages.length > 0) result.oldestSeq = snapshot.messages[0].seq;
    return result;
}

export function syncMessageBytes(message: SyncMessage): number {
    return Buffer.byteLength(JSON.stringify(message), 'utf8');
}

/**
 * §4.4 ack budget. Walks results in order and spends `budget` bytes of
 * message payload. An increment that does not fit is cut at the tail and
 * marked `hasMore` (the client continues with subscribe); a latest page keeps
 * its NEWEST messages and moves `oldestSeq` up (older ones are a scroll-up
 * away). The very first message of the whole ack is always kept so a single
 * oversized message cannot stall a client forever.
 */
export function applyAckBudget(results: SyncSubResultOk[], budget: number): SyncSubResultOk[] {
    let remaining = budget;
    let keptAny = false;
    return results.map((result) => {
        if (result.messages.length === 0) return result;
        const isLatestPage = result.oldestSeq !== undefined;
        const ordered = isLatestPage ? [...result.messages].reverse() : result.messages;
        const kept: SyncMessage[] = [];
        for (const message of ordered) {
            const bytes = syncMessageBytes(message);
            if (bytes > remaining && keptAny) break;
            remaining -= bytes;
            keptAny = true;
            kept.push(message);
        }
        if (kept.length === result.messages.length) return result;
        if (isLatestPage) {
            kept.reverse();
            const truncated: SyncSubResultOk = { ...result, messages: kept };
            if (kept.length > 0) truncated.oldestSeq = kept[0].seq;
            else delete truncated.oldestSeq;
            // Nothing of the page fit: ask the client to come back with subscribe.
            if (kept.length === 0) truncated.hasMore = true;
            return truncated;
        }
        return { ...result, messages: kept, hasMore: true };
    });
}
