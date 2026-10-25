/**
 * B-813 (spec B-807 §5.4 / §5.4.2): the pure rules of the message cache.
 *
 * Per session the cache holds ONE run `[oldestSeq, lastSeq]` that server
 * RANGE results have covered completely (spec B-807 r1 §5.4): every message
 * the server has in that range is a row, at most CACHE_MAX_MESSAGES rows
 * (the newest are kept). Old sessions have permanent seq holes (§4.2.1), so
 * the run may hold fewer rows than `lastSeq - oldestSeq + 1`.
 */

export const CACHE_MAX_MESSAGES = 300;

export type CachedRow = { id: string; seq: number };

/** What the `sessions` store says about one session's run. */
export type SegmentInfo = { oldestSeq: number; lastSeq: number; count: number };

/** Sorted by seq, one row per seq (the first seen wins). */
export function sortUniqueBySeq<R extends CachedRow>(rows: readonly R[]): R[] {
    const bySeq = new Map<number, R>();
    for (const row of rows) {
        if (!Number.isInteger(row.seq) || row.seq < 1) continue;
        if (!bySeq.has(row.seq)) bySeq.set(row.seq, row);
    }
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** The newest `max` rows of a latest page — the whole page is a server range result (spec r1 §5.1 rule 3). */
export function newestRows<R extends CachedRow>(rows: readonly R[], max = CACHE_MAX_MESSAGES): R[] {
    return sortUniqueBySeq(rows).slice(-max);
}

/**
 * Rows above the run `(…, lastSeq]`. A range result (a forward page asked
 * with `after_seq = afterSeq`) holds every message that exists in
 * `(afterSeq, max]`, so when `afterSeq <= lastSeq` it extends the run to its
 * max even across seq holes (§4.2.1). A point row (a live push) extends it
 * only as `lastSeq + 1`. What is left above a gap waits.
 */
export function extendUpward<R extends CachedRow>(
    lastSeq: number,
    points: readonly R[],
    ranges: ReadonlyArray<{ afterSeq: number; rows: readonly R[] }> = [],
): { append: R[]; cover: number; waiting: R[]; waitingRanges: Array<{ afterSeq: number; rows: R[] }> } {
    const all = sortUniqueBySeq([...points, ...ranges.flatMap((range) => range.rows)]).filter((row) => row.seq > lastSeq);
    const pending = ranges.map((range) => ({ afterSeq: range.afterSeq, max: range.rows.reduce((m, row) => Math.max(m, row.seq), range.afterSeq), rows: range.rows }));
    const pointSeqs = new Set(points.map((row) => row.seq));
    let cover = lastSeq;
    for (let progressed = true; progressed;) {
        progressed = false;
        for (const range of pending) {
            if (range.afterSeq <= cover && range.max > cover) { cover = range.max; progressed = true; }
        }
        while (pointSeqs.has(cover + 1)) { cover += 1; progressed = true; }
    }
    return {
        append: all.filter((row) => row.seq <= cover),
        cover,
        waiting: all.filter((row) => row.seq > cover && pointSeqs.has(row.seq)),
        waitingRanges: pending.filter((range) => range.max > cover).map((range) => ({ afterSeq: range.afterSeq, rows: range.rows.filter((row) => row.seq > cover) as R[] })),
    };
}

/**
 * An older page (`before_seq = beforeSeq`, a range result) extends the run
 * downward when it reaches it (`beforeSeq >= oldestSeq`): its rows below
 * `oldestSeq`, nearest first, at most `room` of them.
 */
export function extendDownward<R extends CachedRow>(oldestSeq: number, rows: readonly R[], beforeSeq: number, room: number): R[] {
    if (room <= 0 || beforeSeq < oldestSeq) return [];
    return sortUniqueBySeq(rows).filter((row) => row.seq < oldestSeq).slice(-room);
}

export type CorruptReason = 'schema' | 'range' | 'duplicate';

/**
 * §5.4.2 (r1): the rows read for `info` (the newest ≤300 in
 * `[oldestSeq, lastSeq]`, ascending) must lie inside the range, once each;
 * the session may have no row outside it and no more rows than the range
 * can hold. FEWER rows than the range is long is a
 * historical seq hole (§4.2.1), not corruption. `rowIsValid` is the
 * SyncMessage schema check.
 */
export function validateSegment<R extends CachedRow>(
    info: SegmentInfo,
    rows: readonly R[],
    rowIsValid: (row: R) => boolean,
    /** Rows of the session in `[oldestSeq, lastSeq]` and in total (`IDBObjectStore.count`). */
    counts: { inRange: number; total: number } = { inRange: rows.length, total: rows.length },
): { ok: true } | { ok: false; reason: CorruptReason } {
    if (!Number.isInteger(info.lastSeq) || !Number.isInteger(info.oldestSeq) || info.oldestSeq < 1 || info.oldestSeq > info.lastSeq) {
        return { ok: false, reason: 'range' };
    }
    if (rows.length === 0) return { ok: false, reason: 'range' };
    for (let i = 0; i < rows.length; i++) {
        if (!rowIsValid(rows[i])) return { ok: false, reason: 'schema' };
        if (rows[i].seq < info.oldestSeq || rows[i].seq > info.lastSeq) return { ok: false, reason: 'range' };
        if (i > 0 && rows[i].seq <= rows[i - 1].seq) return { ok: false, reason: 'duplicate' };
    }
    if (counts.total > counts.inRange || counts.inRange > info.lastSeq - info.oldestSeq + 1) return { ok: false, reason: 'range' };
    return { ok: true };
}

export type AnchorVerdict = 'ok' | 'behind' | 'mismatch';

/**
 * §5.4.2 rows 5–6 over the REST cursor: the catch-up after a cache hit asks
 * `after_seq = lastRowSeq - 1`, so the server's first row must be the cached
 * newest row. Missing → the server is behind the cache (DB restored, session
 * recreated); another id → the cache is not this session's history.
 */
export function checkCacheAnchor(
    page: ReadonlyArray<CachedRow>,
    lastSeq: number,
    lastId: string,
): AnchorVerdict {
    const row = page.find((message) => message.seq === lastSeq);
    if (!row) return 'behind';
    return row.id === lastId ? 'ok' : 'mismatch';
}
