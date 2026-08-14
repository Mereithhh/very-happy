/**
 * notes — pure data layer for prompt notes (B-094): record shape, KV key
 * mapping, caps, LWW merge and title derivation. The KV carrier and React
 * store live in notesStore.ts; this module has no I/O so it stays testable.
 *
 * Storage model: ONE KV KEY PER NOTE (`vh.note.v1.<id>`), not a single blob.
 * Two devices editing different notes then never conflict; editing the SAME
 * note conflicts at that one key, and the KV 409 body carries the winner so
 * the store can resolve by `updatedAt` (last write wins, tie → remote).
 */

export const NOTE_KV_PREFIX = 'vh.note.v1.';

/**
 * Caps. KV has no per-value limit and the MMKV mirror sits on localStorage
 * (~5MB quota — same constraint that capped clipboard history at 50×32KB in
 * clipboardHistory.ts), so both bounds are enforced client-side.
 */
export const NOTE_CONTENT_MAX_CHARS = 32_768;
export const NOTES_MAX_COUNT = 200;

/** Derived tab/list titles are clipped to this many chars. */
export const NOTE_TITLE_MAX_CHARS = 32;

export interface NoteBinding {
    kind: 'session' | 'terminal';
    /** session id, or terminal id (tid) for kind 'terminal' */
    id: string;
    /** terminal jump links need the machine too */
    machineId?: string;
    /** display snapshot — survives the target being archived/closed */
    title: string;
}

export interface NoteRecord {
    id: string;
    content: string;
    boundTo?: NoteBinding | null;
    createdAt: number;
    updatedAt: number;
}

export function noteKvKey(id: string): string {
    return NOTE_KV_PREFIX + id;
}

/** Inverse of noteKvKey; null when the key is not a note key. */
export function noteIdFromKvKey(key: string): string | null {
    if (!key.startsWith(NOTE_KV_PREFIX)) return null;
    const id = key.slice(NOTE_KV_PREFIX.length);
    return id.length > 0 ? id : null;
}

/** Validate an unknown decoded JSON value into a NoteRecord (or reject). */
export function parseNoteRecord(raw: unknown): NoteRecord | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const o = raw as Record<string, unknown>;
    if (typeof o.id !== 'string' || o.id.length === 0) return null;
    if (typeof o.content !== 'string') return null;
    if (typeof o.createdAt !== 'number' || !Number.isFinite(o.createdAt)) return null;
    if (typeof o.updatedAt !== 'number' || !Number.isFinite(o.updatedAt)) return null;
    let boundTo: NoteBinding | null = null;
    if (typeof o.boundTo === 'object' && o.boundTo !== null) {
        const b = o.boundTo as Record<string, unknown>;
        if ((b.kind === 'session' || b.kind === 'terminal') && typeof b.id === 'string' && typeof b.title === 'string') {
            boundTo = {
                kind: b.kind,
                id: b.id,
                title: b.title,
                ...(typeof b.machineId === 'string' ? { machineId: b.machineId } : {}),
            };
        }
    }
    return {
        id: o.id,
        // Defensive clamp: a foreign writer (older/newer client) must not blow
        // the MMKV mirror past the localStorage quota.
        content: o.content.slice(0, NOTE_CONTENT_MAX_CHARS),
        boundTo,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
    };
}

/**
 * LWW winner between two versions of the same note. Remote wins ties so a
 * stuck local copy converges to what the server already has.
 */
export function pickNoteWinner(local: NoteRecord, remote: NoteRecord): NoteRecord {
    return local.updatedAt > remote.updatedAt ? local : remote;
}

/**
 * Title = first non-empty line, minus markdown heading/list prefixes, clipped.
 * Notes have no separate title field on purpose (one less thing to sync).
 */
export function deriveNoteTitle(content: string): string {
    for (const rawLine of content.split('\n')) {
        const line = rawLine.replace(/^[#>\-*\s]+/, '').trim();
        if (line.length === 0) continue;
        return line.length > NOTE_TITLE_MAX_CHARS ? line.slice(0, NOTE_TITLE_MAX_CHARS - 1) + '…' : line;
    }
    return '';
}

/** Panel/list order: most recently touched first (stable for equal stamps). */
export function sortNotes(notes: readonly NoteRecord[]): NoteRecord[] {
    return [...notes].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export function newNoteId(): string {
    // 12 hex chars of randomness — short enough for a KV key, collision-safe
    // for a personal notes count capped at NOTES_MAX_COUNT.
    const bytes = new Uint8Array(6);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Drop ids from the tab list that no longer resolve to a live note. */
export function pruneNoteTabs(tabs: readonly string[], ids: ReadonlySet<string>): string[] {
    return tabs.filter((id) => ids.has(id));
}

/** Next active tab after closing `closed` (neighbor to the left, then right). */
export function nextActiveTab(tabs: readonly string[], closed: string): string | null {
    const idx = tabs.indexOf(closed);
    if (idx === -1) return tabs.length > 0 ? tabs[tabs.length - 1] : null;
    const rest = tabs.filter((id) => id !== closed);
    if (rest.length === 0) return null;
    return rest[Math.min(Math.max(idx - 1, 0), rest.length - 1)];
}
