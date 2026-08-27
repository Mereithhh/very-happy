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
