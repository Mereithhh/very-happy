/**
 * B-812 (B-807 spec §5.1, PR-5b): the ONE merge entry for a session's
 * messages. Every source — live push, send ack, relay commit, socket snapshot
 * (sync-hello / session-subscribe ack), REST catch-up, latest page, older page
 * — goes through `planMerge`; sync.ts' `mergeSessionMessages` is its thin
 * wrapper (lock + store write + side effects + timers).
 *
 * The cursor of a session is `lastSeq` (everything at or below it is reduced
 * or provably absent), `oldestSeq` (backward pagination), the reorder buffer
 * of point items past `lastSeq + 1`, and the side-effect high-water mark.
 *
 * Two kinds of sources move `lastSeq` differently (spec r1 §4.2.1, §5.1-3):
 *  - point sources (push, send-ack, relay-committed) prove only their
 *    own seqs exist: they advance through a contiguous run only, anything past
 *    a hole waits REORDER_WINDOW_MS in the reorder buffer — two slots' emits
 *    reach the Redis stream out of commit order — and is a gap after that;
 *  - range sources (snapshot, rest, latest-page, older-page, and the cached
 *    run — the stored copy of such ranges, B-813) are the server's
 *    "every message that exists in this range": a seq missing inside the range
 *    does not exist (old sessions carry permanent seq holes), it is NOT a gap.
 *    A snapshot with `hasMore=false` moves lastSeq to `headSeq` — the only
 *    proof of `live` (G2) — even when the newest row is below it.
 * The only head inconsistency is `headSeq < afterSeq of THAT request`: compared
 * with the request's afterSeq, never the current lastSeq, which a push or a
 * send ack may already have moved past the snapshot's head.
 */
import { sortIncomingBySeq } from './messageOrder';

export type MergeSource =
    | 'cache'           // IndexedDB cached run (B-813): a stored range, anchored at its lastSeq
    | 'snapshot'        // sync-hello / session-subscribe ack increment
    | 'latest-page'     // afterSeq=null or gapTooLarge ack, or the REST first page
    | 'push'            // update/new-message
    | 'send-ack'        // POST /v3 response {id, seq, localId}
    | 'relay-committed' // session-message-committed
    | 'older-page'      // before_seq pagination
    | 'rest';           // REST after_seq (legacy mode or fallback)

const POINT_SOURCES: ReadonlySet<MergeSource> = new Set(['push', 'send-ack', 'relay-committed']);
/** Range results of a superseded request must not land on newer state. */
const GENERATION_SOURCES: ReadonlySet<MergeSource> = new Set(['snapshot', 'latest-page', 'rest']);
/**
 * Rule 6: lifecycle side effects (thinking, heartbeat, sidebar). The spec
 * allows push / snapshot / rest; only the push carries them today — catch-ups
 * never moved `thinking` (it converges from the CLI keepAlive), and a range
 * result must not swallow the effects of a push that arrives after it.
 * cache / older-page / latest-page never do.
 */
const EFFECT_SOURCES: ReadonlySet<MergeSource> = new Set(['push']);

export const isPointSource = (source: MergeSource) => POINT_SOURCES.has(source);

/** Rule 4: how long a point item past a hole waits for the hole to fill. */
export const REORDER_WINDOW_MS = 400;
/** Point items buffered per session before the first page lands; past it they surface as a gap. */
export const PENDING_LIMIT = 500;

/** `message: null` = the seq exists but has nothing to reduce (a send ack, an unrenderable record). */
export type MergeItem<M> = { seq: number; message: M | null };

export type SessionCursor<M> = {
    lastSeq?: number;
    oldestSeq?: number;
    /** Catch-up generation; range results of an older one are dropped (rule 1). */
    generation: number;
    /** Point items past lastSeq + 1, or before the first anchor. */
    pending: Map<number, M | null>;
    /** When the reorder window of the current hole closes (ms clock). */
    reorderDeadline?: number;
    /** The first page was requested — later point items only join `pending`. */
    anchorRequested: boolean;
    /** Highest seq whose side effects already ran. */
    effectedSeq?: number;
};

export function createCursor<M>(): SessionCursor<M> {
    return { generation: 0, pending: new Map(), anchorRequested: false };
}

export type MergeMeta = {
    now: number;
    /** Generation the range request was issued under. */
    generation?: number;
    /** afterSeq OF THE REQUEST (snapshot/rest); null = cold. */
    afterSeq?: number | null;
    /** Session.seq from the same snapshot (socket acks only). */
    headSeq?: number;
    hasMore?: boolean;
    /** latest-page from a gapTooLarge ack: the old window is discarded. */
    gapTooLarge?: boolean;
};

export type MergeOutcome =
    /** Merged; `live` = hasMore=false with a head that proves it. */
    | 'merged'
    /** Range result of a superseded request: nothing applied. */
    | 'superseded'
    /** headSeq < request afterSeq: local state is ahead of the server (spec §6.2-10). */
    | 'head-behind'
    /** A row outside (afterSeq, headSeq] — impossible within one snapshot: a server bug (§4.2). */
    | 'invalid';

export type MergePlan<M> = {
    outcome: MergeOutcome;
    /** To reduce now, seq ascending (rule 2 / 铁律 15). */
    apply: M[];
    /** Items whose side effects run now (rule 6), seq ascending. */
    effects: MergeItem<M>[];
    lastSeqBefore: number | undefined;
    /** hasMore=false and the head proved the range complete. */
    live: boolean;
    /** The old window must be dropped before `apply` (latest-page reset). */
    resetWindow: boolean;
    /** A point item arrived before any anchor and nobody asked for the first page yet. */
    needAnchor: boolean;
};

function maxOf(seqs: readonly number[], floor: number | undefined): number | undefined {
    let max = floor;
    for (const seq of seqs) if (max === undefined || seq > max) max = seq;
    return max;
}

/** Advance lastSeq through pending's contiguous run; returns the messages it passed. */
function drainContiguous<M>(cursor: SessionCursor<M>, out: Array<{ seq: number; message: M | null }>) {
    if (cursor.lastSeq === undefined) return;
    for (const seq of [...cursor.pending.keys()].sort((a, b) => a - b)) {
        if (seq <= cursor.lastSeq) {
            // Covered (a range result) or an echo: the message is reduced or absent.
            out.push({ seq, message: cursor.pending.get(seq) ?? null });
            cursor.pending.delete(seq);
        } else if (seq === cursor.lastSeq + 1) {
            out.push({ seq, message: cursor.pending.get(seq) ?? null });
            cursor.pending.delete(seq);
            cursor.lastSeq = seq;
        } else {
            break;
        }
    }
}

function armOrClearReorder<M>(cursor: SessionCursor<M>, now: number) {
    const hasHole = cursor.lastSeq !== undefined && [...cursor.pending.keys()].some((seq) => seq > cursor.lastSeq!);
    if (!hasHole) cursor.reorderDeadline = undefined;
    else if (cursor.reorderDeadline === undefined) cursor.reorderDeadline = now + REORDER_WINDOW_MS;
}

function sortedUnique<M>(items: readonly MergeItem<M>[]): MergeItem<M>[] {
    const sorted = sortIncomingBySeq([...items]);
    const out: MergeItem<M>[] = [];
    for (const item of sorted) {
        if (out.length > 0 && out[out.length - 1].seq === item.seq) continue;
        out.push(item);
    }
    return out;
}

/**
 * Merge `items` from `source` into `cursor` (mutated). Pure apart from that:
 * the caller reduces `plan.apply`, runs `plan.effects`, and arms the reorder
 * timer from `cursor.reorderDeadline`.
 */
export function planMerge<M>(cursor: SessionCursor<M>, rawItems: readonly MergeItem<M>[], source: MergeSource, meta: MergeMeta): MergePlan<M> {
    const lastSeqBefore = cursor.lastSeq;
    const plan: MergePlan<M> = { outcome: 'merged', apply: [], effects: [], lastSeqBefore, live: false, resetWindow: false, needAnchor: false };
    // Rule 1: generation filter (range results of a cancelled request).
    if (GENERATION_SOURCES.has(source) && meta.generation !== undefined && meta.generation < cursor.generation) {
        plan.outcome = 'superseded';
        return plan;
    }
    const items = sortedUnique(rawItems);
    const seqs = items.map((item) => item.seq);

    // Snapshot consistency (§4.2): judged against the REQUEST's afterSeq.
    if (meta.headSeq !== undefined && (source === 'snapshot' || source === 'latest-page')) {
        if (typeof meta.afterSeq === 'number' && meta.headSeq < meta.afterSeq) {
            plan.outcome = 'head-behind';
            return plan;
        }
        const floor = source === 'snapshot' && typeof meta.afterSeq === 'number' ? meta.afterSeq : -Infinity;
        if (seqs.some((seq) => seq > meta.headSeq! || seq <= floor)) {
            plan.outcome = 'invalid';
            return plan;
        }
    }

    // Rule 6: side effects for facts this tab has not acted on yet.
    if (EFFECT_SOURCES.has(source)) {
        plan.effects = items.filter((item) => cursor.effectedSeq === undefined || item.seq > cursor.effectedSeq);
    }
    if (EFFECT_SOURCES.has(source)) cursor.effectedSeq = maxOf(seqs, cursor.effectedSeq);

    const passed: Array<{ seq: number; message: M | null }> = [];
    if (POINT_SOURCES.has(source)) {
        if (cursor.lastSeq === undefined) {
            // No anchor yet: wait for the first page (B-805), ask for it once.
            for (const item of items) {
                if (cursor.pending.size >= PENDING_LIMIT && !cursor.pending.has(item.seq)) break;
                cursor.pending.set(item.seq, item.message);
            }
            if (!cursor.anchorRequested && items.length > 0) {
                cursor.anchorRequested = true;
                plan.needAnchor = true;
            }
            return plan;
        }
        // An echo (seq <= lastSeq: reduced already) is dropped by drainContiguous.
        for (const item of items) cursor.pending.set(item.seq, item.message);
        drainContiguous(cursor, passed);
        armOrClearReorder(cursor, meta.now);
        plan.apply = passed.filter((entry) => entry.seq > (lastSeqBefore ?? -Infinity) && entry.message !== null).map((entry) => entry.message as M);
        return plan;
    }

    if (source === 'older-page') {
        const min = items.length > 0 ? items[0].seq : undefined;
        if (min !== undefined && (cursor.oldestSeq === undefined || min < cursor.oldestSeq)) cursor.oldestSeq = min;
        plan.apply = items.flatMap((item) => (item.message !== null ? [item.message] : []));
        return plan;
    }

    // Range sources that move the forward cursor: snapshot, rest, latest-page.
    const maxSeq = maxOf(seqs, undefined);
    const minSeq = items.length > 0 ? items[0].seq : undefined;
    // A cached run anchors like a first page at the lastSeq it was stored with (meta.headSeq);
    // it is not live (no head was read): the catch-up after it proves the rest (§5.3).
    const cold = source === 'latest-page' || source === 'cache' || cursor.lastSeq === undefined;
    if (cold) {
        plan.resetWindow = source === 'latest-page' && meta.gapTooLarge === true && cursor.lastSeq !== undefined;
        if (plan.resetWindow) {
            cursor.lastSeq = undefined;
            cursor.oldestSeq = undefined;
        }
        // The page anchors at the head when the server said so, else at its newest row; never backwards.
        // An empty REST first page anchors at 0 (the session has no messages yet).
        const anchor = maxOf(meta.headSeq !== undefined ? [meta.headSeq] : [], maxSeq) ?? (source === 'latest-page' ? 0 : undefined);
        if (anchor !== undefined) cursor.lastSeq = Math.max(cursor.lastSeq ?? anchor, anchor);
        if (minSeq !== undefined && (cursor.oldestSeq === undefined || minSeq < cursor.oldestSeq || plan.resetWindow)) cursor.oldestSeq = minSeq;
        cursor.anchorRequested = false;
        if (anchor !== undefined) {
            // Buffered point items the page covers are echoes; the rest run on from the anchor.
            for (const seq of [...cursor.pending.keys()]) if (seq <= cursor.lastSeq!) cursor.pending.delete(seq);
        }
    } else {
        if (maxSeq !== undefined) cursor.lastSeq = Math.max(cursor.lastSeq!, maxSeq);
    }
    if (meta.hasMore === false && meta.headSeq !== undefined) {
        // Rule 5: the head proves (afterSeq, headSeq] complete — holes included.
        cursor.lastSeq = Math.max(cursor.lastSeq ?? meta.headSeq, meta.headSeq);
        plan.live = true;
    }
    drainContiguous(cursor, passed);
    armOrClearReorder(cursor, meta.now);

    const applied = new Map<number, M>();
    for (const item of items) if (item.message !== null) applied.set(item.seq, item.message);
    for (const entry of passed) if (entry.message !== null && !applied.has(entry.seq)) applied.set(entry.seq, entry.message);
    plan.apply = [...applied.entries()].sort((a, b) => a[0] - b[0]).map(([, message]) => message);
    return plan;
}

/** The reorder window closed with a hole left: the range to fetch (afterSeq = lastSeq). */
export function expireReorder<M>(cursor: SessionCursor<M>, now: number): { from: number; to: number } | null {
    if (cursor.reorderDeadline === undefined || now < cursor.reorderDeadline) return null;
    cursor.reorderDeadline = undefined;
    if (cursor.lastSeq === undefined) return null;
    const ahead = [...cursor.pending.keys()].filter((seq) => seq > cursor.lastSeq!).sort((a, b) => a - b);
    if (ahead.length === 0) return null;
    return { from: cursor.lastSeq + 1, to: ahead[0] - 1 };
}

/** Local state is not trustworthy (head behind): forget the cursor; the next page is cold. The generation is the scheduler's. */
export function resetCursor<M>(cursor: SessionCursor<M>) {
    cursor.lastSeq = undefined;
    cursor.oldestSeq = undefined;
    cursor.reorderDeadline = undefined;
    cursor.anchorRequested = false;
    cursor.pending.clear();
}
