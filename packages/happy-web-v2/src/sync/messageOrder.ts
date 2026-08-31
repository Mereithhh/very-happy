import type { Message } from './typesMessage';

/**
 * Newest-first comparator for the chat message list (the chat list is
 * inverted: index 0 renders at the visual bottom).
 *
 * Ordering keys, in priority order:
 *
 * 1. `seq` — the server-assigned per-session sequence number. This is the
 *    authoritative conversation order. It is required because `createdAt`
 *    alone is not a total order: the server stamps every message of a POSTed
 *    batch with the same transaction timestamp, and history backfill pages
 *    arrive newest-first, so relying on Map insertion order for ties renders
 *    batches reversed / interleaved wrongly.
 * 2. `createdAt` — used when either side has no seq (locally synthesized
 *    messages: optimistic sends, permission requests from agent state).
 * 3. `sortOrder` — monotonic reducer creation counter; breaks remaining ties
 *    (e.g. several blocks of one source message share seq and createdAt, and
 *    are created in content order, so the newer block has the higher counter).
 *
 * Returning 0 keeps the (stable) sort's existing relative order.
 */
export function compareMessagesNewestFirst(a: Message, b: Message): number {
    const aSeq = typeof a.displaySeq === 'number' ? a.displaySeq : a.seq;
    const bSeq = typeof b.displaySeq === 'number' ? b.displaySeq : b.seq;
    if (typeof aSeq === 'number' && typeof bSeq === 'number' && aSeq !== bSeq) {
        return bSeq - aSeq;
    }
    const aTime = a.displayAt ?? a.createdAt;
    const bTime = b.displayAt ?? b.createdAt;
    if (aTime !== bTime) {
        return bTime - aTime;
    }
    if (typeof a.sortOrder === 'number' && typeof b.sortOrder === 'number' && a.sortOrder !== b.sortOrder) {
        return b.sortOrder - a.sortOrder;
    }
    return 0;
}

/**
 * Batch-input ordering for the reducer/storage pipeline (B-261).
 *
 * History backfill pages arrive newest-first (`before_seq` DESC) and were fed
 * to the reducer in arrival order. The tracer and the plan-mode scan both
 * depend on chronological order: a DESC page flattens `Agent` sidechain
 * children into top-level rows (the parent tool call is traced after its
 * children), leaves child tool-results permanently running, and an
 * [Exit, Enter] plan-mode pair read backwards re-enters plan mode.
 *
 * Sorts a batch ascending by `seq` — but ONLY when every message in the batch
 * carries a numeric seq. Mixed batches (optimistic sends and locally
 * synthesized messages have no seq) admit no total order, and for them the
 * arrival order IS the correct order; sorting a mixed batch with a partial
 * comparator would be undefined. Returns the input array untouched (same
 * reference) when it is already sorted or not fully seq-carrying.
 */
export function sortIncomingBySeq<T extends { seq?: number | null }>(messages: T[]): T[] {
    if (messages.length < 2) return messages;
    let previous = -Infinity;
    let sorted = true;
    for (const message of messages) {
        if (typeof message.seq !== 'number') return messages;
        if (message.seq < previous) sorted = false;
        previous = message.seq;
    }
    if (sorted) return messages;
    return [...messages].sort((a, b) => (a.seq as number) - (b.seq as number));
}
