/**
 * clipboardHistory — PURE logic for the clipboard-push history list
 * (no imports on purpose — unit-tested in a plain node environment).
 *
 * The store lives in clipboardHistoryStore.ts (MMKV persistence, React hook);
 * this module owns the list semantics so they stay testable:
 *  - newest first;
 *  - identical text dedupes: a re-push of the same content MOVES the entry to
 *    the top (fresh timestamp) instead of duplicating it;
 *  - hard cap (oldest dropped).
 */

export interface ClipboardHistoryEntry {
    id: string;
    /** full plaintext as received (already capped by clipboardPush) */
    text: string;
    createdAt: number;
    /** where the push came from (best-effort, may be absent) */
    sourceType?: 'machine' | 'session';
    /** machineId / sessionId matching sourceType */
    sourceId?: string;
    /** display label resolved at push time (session title / machine name) */
    sourceLabel?: string;
}

/** hard cap on stored entries (newest kept) */
export const CLIPBOARD_HISTORY_CAP = 50;

/**
 * Per-entry text cap for HISTORY persistence only (the live clipboard write
 * still gets the full payload). Pushes carry up to 256KB; the MMKV web shim
 * is localStorage (~5MB quota), so 50 × 256KB would silently blow the quota
 * (mmkv-web soft-fails set). 32KB × 50 ≈ 1.6MB worst case stays safe.
 */
export const CLIPBOARD_HISTORY_TEXT_CHARS = 32 * 1024;

/** Truncate a payload to the history persistence cap. */
export function truncateForHistory(
    text: string,
    max: number = CLIPBOARD_HISTORY_TEXT_CHARS,
): string {
    return text.length > max ? text.slice(0, max) : text;
}

/**
 * Prepend `entry` to `entries` (newest first): drop any existing entry with
 * identical text (re-push = move to top, not duplicate), then trim to `cap`.
 * Pure — always returns a new array.
 */
export function appendClipboardEntry(
    entries: ClipboardHistoryEntry[],
    entry: ClipboardHistoryEntry,
    cap: number = CLIPBOARD_HISTORY_CAP,
): ClipboardHistoryEntry[] {
    const rest = entries.filter((e) => e.text !== entry.text);
    return [entry, ...rest].slice(0, Math.max(1, cap));
}

/** Remove one entry by id. Returns the same array when nothing matched. */
export function removeClipboardEntry(
    entries: ClipboardHistoryEntry[],
    id: string,
): ClipboardHistoryEntry[] {
    if (!entries.some((e) => e.id === id)) return entries;
    return entries.filter((e) => e.id !== id);
}

/** Replace the text of one entry (history-row edit). Same array when no-op. */
export function updateClipboardEntryText(
    entries: ClipboardHistoryEntry[],
    id: string,
    text: string,
): ClipboardHistoryEntry[] {
    if (!entries.some((e) => e.id === id && e.text !== text)) return entries;
    return entries.map((e) => (e.id === id ? { ...e, text } : e));
}

/**
 * Single-line preview for toasts / history rows: collapse all whitespace to
 * single spaces, trim, and truncate to `max` chars with an ellipsis.
 */
export function clipboardPreview(text: string, max: number = 40): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    if (flat.length <= max) return flat;
    return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Runtime validator for entries parsed from persisted JSON. */
export function isClipboardHistoryEntry(e: unknown): e is ClipboardHistoryEntry {
    if (!e || typeof e !== 'object') return false;
    const v = e as Record<string, unknown>;
    return (
        typeof v.id === 'string' &&
        typeof v.text === 'string' &&
        typeof v.createdAt === 'number' &&
        (v.sourceType === undefined || v.sourceType === 'machine' || v.sourceType === 'session') &&
        (v.sourceId === undefined || typeof v.sourceId === 'string') &&
        (v.sourceLabel === undefined || typeof v.sourceLabel === 'string')
    );
}
