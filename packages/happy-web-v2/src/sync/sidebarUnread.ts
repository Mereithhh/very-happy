/**
 * sidebarUnread — PURE model for the sidebar's 未读 red dot (B-312).
 *
 * The signal itself is old (B-085): `storage.unreadSessionIds` collects the
 * sessions whose agent went running → idle while the user was looking
 * somewhere else, and opening the session clears it. What was missing is that
 * the set lived ONLY in the zustand store, so an F5 — or a PWA the OS
 * discarded — erased every pending "come look at this" marker. A reminder that
 * a refresh can silently delete is not a reminder, so the set is now mirrored
 * into MMKV/localStorage (persistence.ts does the I/O; this file is the model).
 *
 * Stored shape is `sessionId → markedAt` rather than a plain id array, because
 * the two guards below both need the age:
 *
 *  - AGE (`UNREAD_MAX_AGE_MS`): a red dot that survives a week is noise, not a
 *    prompt. Anything older is dropped on load and on write.
 *  - CAP (`UNREAD_MAX_KEYS`): newest wins. Bounds the blob for accounts with
 *    hundreds of sessions; evicting the oldest only loses a dot that was
 *    already about to age out.
 *
 * Scope is this device, and the last writer of a whole-blob mirror wins — two
 * open tabs each hold their own in-memory Set, so a write from one can drop a
 * dot the other just added. Same property every MMKV map in persistence.ts has
 * (drafts, permission modes), and the failure is one dot clearing early, so it
 * does not justify the read-merge-write CAS that the SYNCED read state needs
 * (notificationSeen.ts — that one is cross-device and merges by per-key max).
 *
 * Restoring is deliberately NOT gated on the session still existing: the store
 * seeds before any session has synced, and rows for missing/archived sessions
 * are never rendered anyway (Sidebar only asks about `r.kind === 'session' &&
 * r.session?.active`), so a stale id is invisible until age/cap reaps it.
 */

/** session id → wall clock ms when the turn finished unseen */
export type UnreadRecord = Readonly<Record<string, number>>;

/** dots older than this are dropped (load and save) */
export const UNREAD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** hard cap on stored ids (newest markedAt kept) */
export const UNREAD_MAX_KEYS = 200;

/** Tolerant parse: any malformed blob degrades to "nothing unread". */
export function parseUnreadRecord(raw: string | undefined | null): UnreadRecord {
    if (!raw) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
        if (!id) continue;
        if (typeof at !== 'number' || !Number.isFinite(at)) continue;
        out[id] = at;
    }
    return out;
}

/** Drop aged-out ids, then keep the newest `UNREAD_MAX_KEYS`. */
export function pruneUnreadRecord(record: UnreadRecord, now: number): UnreadRecord {
    const alive = Object.entries(record).filter(([, at]) => now - at < UNREAD_MAX_AGE_MS);
    if (alive.length > UNREAD_MAX_KEYS) {
        // newest first, stable id tiebreak so two devices prune identically
        alive.sort((a, b) => (b[1] - a[1] !== 0 ? b[1] - a[1] : a[0].localeCompare(b[0])));
        alive.length = UNREAD_MAX_KEYS;
    }
    return Object.fromEntries(alive);
}

/**
 * The record to persist for `ids`, keeping each id's ORIGINAL markedAt so the
 * age guard measures "when the turn finished", not "when we last wrote".
 */
export function nextUnreadRecord(
    previous: UnreadRecord,
    ids: Iterable<string>,
    now: number,
): UnreadRecord {
    const out: Record<string, number> = {};
    for (const id of ids) out[id] = previous[id] ?? now;
    return pruneUnreadRecord(out, now);
}

/** Ids to seed the store with (already pruned). */
export function unreadIdsOf(record: UnreadRecord): string[] {
    return Object.keys(record);
}
