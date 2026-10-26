/**
 * B-823 (B-816 Q4, QA9 P2-3): the first socket connect catches the session
 * list up incrementally instead of downloading it again.
 *
 * The window: the first `/v1/sessions` GET reads its snapshot before this
 * tab's socket has joined the account room, so an update emitted in between
 * (metadata, agent state, archive, a new session) reaches neither. The first
 * connect used to close it with a second full GET — the biggest account's
 * 1.36MB br, again, right after entering (QA9 P2-3). Now it asks the server
 * which rows changed since the snapshot and re-reads only those:
 *
 *  1. `GET /v2/sessions?changedSince=<cursor>` lists the account's rows whose
 *     `updatedAt` is past the cursor. Every Session write goes through Prisma
 *     (`@updatedAt`: metadata/agentState, seq, activity, archive), so a change
 *     after the snapshot is always in it. The cursor is on the server's clock,
 *     never ours: the list response's `Date` header (sent after the snapshot
 *     was read; whole seconds) minus DATE_SLACK_MS, or — when the header is
 *     not readable (a cross-origin self-host) — the snapshot's newest
 *     `updatedAt` minus CHANGED_SINCE_SKEW_MS. Both slacks cover a
 *     transaction that stamped `updatedAt` before the snapshot but committed
 *     after it. The rows come back whole (the route has no projection), so
 *     the later, tighter bound is used: rows changed just before the
 *     snapshot are listed too, only those changed after it are re-read.
 *  2. A row the snapshot already had at the same `updatedAt` is unchanged and
 *     skipped; every other id is re-read with `GET /v1/sessions/:id` (the
 *     list's projection: archivedAt, share). Rows shared WITH this account
 *     are not in the v2 list (it is owner-scoped), so each one the snapshot
 *     had is re-read too.
 *  3. Too many changes, a next page, or any failure → the full list, as
 *     before. The catch-up is never weaker than the second GET it replaces.
 *
 * Not covered, same as the full GET it replaces: a row deleted in the window
 * (the list merges, it never removes; spec B-807 「not in list ≠ deleted」).
 * Not covered and new: a share granted to this account in the window (its
 * row is in neither query) shows on the next resume/reconnect list.
 */

export const CHANGED_SINCE_SKEW_MS = 60_000;
/** `Date` is truncated to the second, plus a transaction's stamp-to-commit time. */
export const DATE_SLACK_MS = 10_000;
/** Above this many re-reads, one full list is cheaper (and simpler). */
export const MAX_DELTA_READS = 20;
/** One page of /v2/sessions (its max). */
export const DELTA_PAGE_LIMIT = 200;

export interface SessionListSnapshot {
    /** Owned rows: id → updatedAt (server ms). */
    owned: ReadonlyMap<string, number>;
    /** Rows shared with this account (not visible to /v2/sessions). */
    shared: readonly string[];
    /** Newest owned updatedAt; 0 when the account has no owned rows. */
    newestUpdatedAt: number;
    /** The list response's `Date` (server clock, ms), when readable. */
    servedAt: number | null;
}

/** A `Date` response header as ms, or null (absent, unreadable cross-origin, malformed). */
export function parseServedAt(header: string | null | undefined): number | null {
    if (!header) return null;
    const at = Date.parse(header);
    return Number.isFinite(at) ? at : null;
}

export function sessionListSnapshot(rows: ReadonlyArray<{ id: string; updatedAt: number; share?: unknown }>, servedAt: number | null = null): SessionListSnapshot {
    const owned = new Map<string, number>();
    const shared: string[] = [];
    let newestUpdatedAt = 0;
    for (const row of rows) {
        if (row.share) {
            shared.push(row.id);
            continue;
        }
        owned.set(row.id, row.updatedAt);
        if (row.updatedAt > newestUpdatedAt) newestUpdatedAt = row.updatedAt;
    }
    return { owned, shared, newestUpdatedAt, servedAt };
}

/**
 * Owner 10-27: the once-per-load `scope=unarchived` read joins the baseline,
 * so the catch-up does not re-read those rows as unknown. Only `owned` grows
 * (a row already there keeps the newer stamp); the cursor bounds stay the
 * first list's — rows read later must not move the cursor past changes the
 * first list missed.
 */
export function mergeSessionListSnapshot(snapshot: SessionListSnapshot, rows: ReadonlyArray<{ id: string; updatedAt: number; share?: unknown }>): SessionListSnapshot {
    const owned = new Map(snapshot.owned);
    for (const row of rows) {
        if (row.share) continue;
        const known = owned.get(row.id);
        if (known === undefined || row.updatedAt > known) owned.set(row.id, row.updatedAt);
    }
    return { ...snapshot, owned };
}

/** `changedSince` for the catch-up: the later of the two safe bounds (the route wants a positive integer). */
export function changedSinceCursor(snapshot: SessionListSnapshot): number {
    const byRows = snapshot.newestUpdatedAt - CHANGED_SINCE_SKEW_MS;
    const byDate = snapshot.servedAt !== null ? snapshot.servedAt - DATE_SLACK_MS : Number.NEGATIVE_INFINITY;
    return Math.max(1, Math.floor(Math.max(byRows, byDate)));
}

export type SessionCatchUpPlan =
    | { kind: 'rows'; ids: string[] }
    | { kind: 'full'; reason: 'more-pages' | 'too-many' };

export function planSessionCatchUp(
    snapshot: SessionListSnapshot,
    changed: ReadonlyArray<{ id: string; updatedAt: number }>,
    hasNext: boolean,
): SessionCatchUpPlan {
    if (hasNext) return { kind: 'full', reason: 'more-pages' };
    const ids = new Set<string>();
    for (const row of changed) {
        const known = snapshot.owned.get(row.id);
        if (known === undefined || row.updatedAt > known) ids.add(row.id);
    }
    for (const id of snapshot.shared) ids.add(id);
    if (ids.size > MAX_DELTA_READS) return { kind: 'full', reason: 'too-many' };
    return { kind: 'rows', ids: [...ids] };
}

export interface SessionCatchUpDeps<Row> {
    snapshot: SessionListSnapshot | null;
    /** One page of `/v2/sessions?changedSince=` (ids + updatedAt are all that is used). */
    listChanged: (changedSince: number) => Promise<{ rows: ReadonlyArray<{ id: string; updatedAt: number }>; hasNext: boolean }>;
    /** `GET /v1/sessions/:id` for each id; a 404 is left out. */
    readRows: (ids: readonly string[]) => Promise<Row[]>;
    apply: (rows: Row[]) => Promise<void> | void;
    /** The full list (the pre-B-823 behavior). */
    fullList: () => void;
    log?: (line: string) => void;
}

export type SessionCatchUpOutcome =
    | { kind: 'rows'; changed: number; reread: number }
    | { kind: 'full'; reason: 'no-baseline' | 'more-pages' | 'too-many' | 'failed' };

/** The catch-up itself; never throws (a failure is the full list). */
export async function catchUpSessionList<Row>(deps: SessionCatchUpDeps<Row>): Promise<SessionCatchUpOutcome> {
    const full = (reason: 'no-baseline' | 'more-pages' | 'too-many' | 'failed'): SessionCatchUpOutcome => {
        deps.log?.(`📥 session catch-up: full list (${reason})`);
        deps.fullList();
        return { kind: 'full', reason };
    };
    if (!deps.snapshot) return full('no-baseline');
    try {
        const changed = await deps.listChanged(changedSinceCursor(deps.snapshot));
        const plan = planSessionCatchUp(deps.snapshot, changed.rows, changed.hasNext);
        if (plan.kind === 'full') return full(plan.reason);
        const rows = plan.ids.length > 0 ? await deps.readRows(plan.ids) : [];
        if (rows.length > 0) await deps.apply(rows);
        deps.log?.(`📥 session catch-up: ${changed.rows.length} changed, ${rows.length} re-read`);
        return { kind: 'rows', changed: changed.rows.length, reread: rows.length };
    } catch (error) {
        deps.log?.(`📥 session catch-up failed: ${error instanceof Error ? error.message : String(error)}`);
        return full('failed');
    }
}
