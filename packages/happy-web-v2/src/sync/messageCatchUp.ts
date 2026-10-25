/**
 * B-803: message catch-up (forward from lastSeq) that never holds the
 * session's message lock across the network.
 *
 * Before: `fetchMessages` took the per-session lock, then awaited the GET.
 * A GET stuck on a dead connection (B-802 B3/B6) therefore also blocked every
 * live message of that session (they apply under the same lock) for as long
 * as the browser kept the dead request — the whole transcript froze.
 *
 * Now: fetch + decrypt outside the lock; take the lock only to merge. The
 * reducer dedupes by id, so a page that overlaps live messages applied in the
 * meantime is harmless, and lastSeq only moves forward.
 */

/** lastSeq after merging a fetched range ending at `fetchedMax`: never backwards. */
export function mergeFetchedLastSeq(current: number | undefined, fetchedMax: number): number {
    return current === undefined ? fetchedMax : Math.max(current, fetchedMax);
}

export type CatchUpPage = { messages: ReadonlyArray<{ seq: number }>; hasMore: boolean };

export type ForwardCatchUpDeps<M> = {
    fetchPage: (afterSeq: number, signal: AbortSignal) => Promise<CatchUpPage>;
    normalize: (page: CatchUpPage) => Promise<M[]>;
    /** The session message lock. Held only while merging, never across a request. */
    withLock: (fn: () => void) => Promise<void>;
    /** B-812: the merge entry (a range source: lastSeq moves to the page's newest seq, never back). */
    merge: (messages: M[], page: CatchUpPage) => void;
    onStalled?: () => void;
};

export function throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

export function pageMaxSeq(page: CatchUpPage, floor: number): number {
    let maxSeq = floor;
    for (const message of page.messages) {
        if (message.seq > maxSeq) maxSeq = message.seq;
    }
    return maxSeq;
}

export async function catchUpForward<M>(deps: ForwardCatchUpDeps<M>, fromSeq: number, signal: AbortSignal): Promise<void> {
    let afterSeq = fromSeq;
    for (;;) {
        const page = await deps.fetchPage(afterSeq, signal);
        const normalized = await deps.normalize(page);
        // Superseded (restart) or timed out while decrypting: the fresh
        // attempt merges instead.
        throwIfAborted(signal);
        const maxSeq = pageMaxSeq(page, afterSeq);
        await deps.withLock(() => deps.merge(normalized, page));
        if (!page.hasMore) return;
        if (maxSeq === afterSeq) {
            deps.onStalled?.();
            return;
        }
        afterSeq = maxSeq;
    }
}
