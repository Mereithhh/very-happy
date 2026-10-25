/**
 * B-811 (B-807 spec §4.2–4.3): the snapshot read behind `sync-hello` and
 * `session-subscribe`.
 *
 * Correctness rests on ONE statement per session: `Session.seq` (the head) and
 * that session's messages come from the same READ COMMITTED statement
 * snapshot, so a message is either visible in it together with the head that
 * counts it, or it commits after the snapshot began — and then its post-commit
 * `update/new-message` emit reaches the caller, which joined its user-scoped
 * room before the read. Reading head and messages in two statements would let
 * a commit land between them (head ≠ page), so never split this query. No
 * transaction is opened, which keeps it pgbouncer transaction-pooling friendly.
 *
 * B-821: the statement is batched — every latest-page read of a hello is ONE
 * statement, every increment read ONE more (`unnest … JOIN "Session" … LEFT
 * JOIN LATERAL`). Each row still carries its own session's head from the same
 * statement snapshot, so the per-session proof holds unchanged; batching only
 * removes the ~4.5ms fixed cost each extra statement paid in production.
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

export type SnapshotRow = {
    idx: number;
    head: number;
    id: string | null;
    seq: number | null;
    content: unknown;
    localId: string | null;
    createdAt: Date | string | null;
    updatedAt: Date | string | null;
};

/**
 * `idx` is the 1-based position of the read in the batch: the same session may
 * be asked for twice in one hello (different afterSeq/limit), so rows are keyed
 * by position, not by session id. A session whose row is gone joins nothing and
 * yields no row at all → `null` (not_found).
 */
const LATEST_BATCH_SQL = `
SELECT r.idx::int AS idx, s."seq" AS head, m."id", m."seq", m."content", m."localId", m."createdAt", m."updatedAt"
FROM unnest($1::text[], $2::int[]) WITH ORDINALITY AS r(sid, lim, idx)
JOIN "Session" s ON s."id" = r.sid
LEFT JOIN LATERAL (
    SELECT "id", "seq", "content", "localId", "createdAt", "updatedAt"
    FROM "SessionMessage"
    WHERE "sessionId" = r.sid
    ORDER BY "seq" DESC LIMIT r.lim
) m ON true`;

const INCREMENT_BATCH_SQL = `
SELECT r.idx::int AS idx, s."seq" AS head, m."id", m."seq", m."content", m."localId", m."createdAt", m."updatedAt"
FROM unnest($1::text[], $2::int[], $3::int[]) WITH ORDINALITY AS r(sid, after_seq, lim, idx)
JOIN "Session" s ON s."id" = r.sid
LEFT JOIN LATERAL (
    SELECT "id", "seq", "content", "localId", "createdAt", "updatedAt"
    FROM "SessionMessage"
    WHERE "sessionId" = r.sid AND "seq" > r.after_seq
    ORDER BY "seq" ASC LIMIT r.lim
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

export interface LatestRead { sessionId: string; limit: number }
export interface IncrementRead { sessionId: string; afterSeq: number; limit: number }

/**
 * Split a batch statement's rows back into one snapshot per read (aligned with
 * the input; `null` = that session row is gone). Rows arrive in no particular
 * order — there is deliberately no outer ORDER BY (an Incremental Sort over
 * 16 × 500 rows cost ~5ms) — so pages are sorted here, seq ascending.
 * Increments fetched limit+1 rows to learn hasMore; the latest page has
 * nothing further forward by definition.
 */
export function splitSnapshotRows(
    rows: SnapshotRow[],
    reads: Array<{ limit: number; afterSeq?: number }>,
    kind: 'latest' | 'increment',
): Array<SessionSnapshot | null> {
    const snapshots: Array<SessionSnapshot | null> = reads.map(() => null);
    for (const row of rows) {
        const index = Number(row.idx) - 1;
        if (!(index >= 0 && index < reads.length)) continue;
        const snapshot = snapshots[index] ?? (snapshots[index] = { head: Number(row.head), messages: [], hasMore: false });
        if (row.id !== null) snapshot.messages.push(toSyncMessage(row));
    }
    return snapshots.map((snapshot, index) => {
        if (!snapshot) return null;
        snapshot.messages.sort((a, b) => a.seq - b.seq);
        if (kind === 'latest') return snapshot;
        const limit = reads[index].limit;
        if (snapshot.messages.length <= limit) return snapshot;
        return { head: snapshot.head, messages: snapshot.messages.slice(0, limit), hasMore: true };
    });
}

/** Every latest page (cold / gapTooLarge) of one hello in ONE statement (§4.2, §4.4). */
export async function readLatestPages(client: SnapshotClient, reads: LatestRead[]): Promise<Array<SessionSnapshot | null>> {
    if (reads.length === 0) return [];
    const rows = await client.$queryRawUnsafe<SnapshotRow[]>(
        LATEST_BATCH_SQL,
        reads.map((read) => read.sessionId),
        reads.map((read) => read.limit),
    );
    return splitSnapshotRows(rows, reads, 'latest');
}

/** Every increment of one hello in ONE statement (§4.2, §4.4). */
export async function readIncrements(client: SnapshotClient, reads: IncrementRead[]): Promise<Array<SessionSnapshot | null>> {
    if (reads.length === 0) return [];
    const rows = await client.$queryRawUnsafe<SnapshotRow[]>(
        INCREMENT_BATCH_SQL,
        reads.map((read) => read.sessionId),
        reads.map((read) => read.afterSeq),
        reads.map((read) => read.limit + 1),
    );
    return splitSnapshotRows(rows, reads, 'increment');
}

/** One session through the batch statements (N = 1). `null` = the session row is gone. */
export async function readSessionSnapshot(
    client: SnapshotClient,
    params: { sessionId: string; afterSeq: number; limit: number } | { sessionId: string; afterSeq: null; limit: number },
): Promise<SessionSnapshot | null> {
    const [snapshot] = params.afterSeq === null
        ? await readLatestPages(client, [{ sessionId: params.sessionId, limit: params.limit }])
        : await readIncrements(client, [{ sessionId: params.sessionId, afterSeq: params.afterSeq, limit: params.limit }]);
    return snapshot;
}

/**
 * Shape a snapshot into the wire result (spec §3.3). `head` is the planning
 * head from the head batch; a page reports the head ITS OWN statement read.
 */
export function buildSubResult(sid: string, plan: SnapshotPlan, head: number, snapshot: SessionSnapshot | null): SyncSubResultOk {
    if (plan.kind === 'none' || !snapshot) {
        return { sid, ok: true, headSeq: head, messages: [], hasMore: false };
    }
    // §4.2: the head batch is an earlier statement — pairing its head with this page tears.
    head = snapshot.head;
    if (plan.kind === 'increment') {
        return { sid, ok: true, headSeq: head, messages: snapshot.messages, hasMore: snapshot.hasMore };
    }
    const result: SyncSubResultOk = { sid, ok: true, headSeq: head, messages: snapshot.messages, hasMore: false };
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
