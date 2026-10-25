/**
 * B-813 (spec B-807 §5.4.1): which cached sessions to drop. Owner 10-25:
 * the 30 most recently viewed sessions, the newest 300 messages each
 * (segment.ts), 40MB in total. A session with an outbox row is never
 * dropped — its unsent message would lose its transcript context.
 */

export const CACHE_MAX_SESSIONS = 30;
export const CACHE_MAX_BYTES = 40 * 1024 * 1024;

export type LruEntry = { sid: string; lastAccessAt: number; bytes: number };

export type LruLimits = { maxSessions: number; maxBytes: number };

const DEFAULT_LIMITS: LruLimits = { maxSessions: CACHE_MAX_SESSIONS, maxBytes: CACHE_MAX_BYTES };

/** Oldest-viewed first until both limits hold; protected sessions are skipped. */
export function pickEvictions(
    entries: readonly LruEntry[],
    isProtected: (sid: string) => boolean,
    limits: LruLimits = DEFAULT_LIMITS,
): string[] {
    let count = entries.length;
    let bytes = entries.reduce((total, entry) => total + Math.max(0, entry.bytes), 0);
    const evict: string[] = [];
    for (const entry of oldestFirst(entries)) {
        if (count <= limits.maxSessions && bytes <= limits.maxBytes) break;
        if (isProtected(entry.sid)) continue;
        evict.push(entry.sid);
        count -= 1;
        bytes -= Math.max(0, entry.bytes);
    }
    return evict;
}

/** §5.4.1 QuotaExceededError: drop the older half of the droppable sessions, then retry once. */
export function pickQuotaEvictions(entries: readonly LruEntry[], isProtected: (sid: string) => boolean): string[] {
    const droppable = oldestFirst(entries).filter((entry) => !isProtected(entry.sid));
    return droppable.slice(0, Math.ceil(droppable.length / 2)).map((entry) => entry.sid);
}

function oldestFirst(entries: readonly LruEntry[]): LruEntry[] {
    return [...entries].sort((a, b) => a.lastAccessAt - b.lastAccessAt || (a.sid < b.sid ? -1 : 1));
}
