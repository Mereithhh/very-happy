/**
 * B-923: the main agent as a column of the desktop layout (it used to be a
 * floating drawer). Pure width / availability / persistence rules:
 *
 *  - The column lives at the right end of the shell's main row (detail |
 *    notes | main agent). It squeezes the session area, never covers it.
 *  - It docks only when the main row is at least DOCK_MIN_ROW wide (sidebar
 *    excluded); narrower windows and phones open the full-screen
 *    /main-agent page instead, as before.
 *  - Width: [DOCK_MIN, min(DOCK_MAX, row − DOCK_HANDLE − DETAIL_RESERVE)].
 *    The session area therefore keeps ≥ DETAIL_RESERVE (646px): its own
 *    right-hand workspace panel (files / preview / board) caps itself at
 *    "container − 326px" (session.css .sd-files: 320 + its 6px handle), so
 *    conversation and workspace panel keep ≥ 320px each. Nothing overlaps
 *    and the row never scrolls sideways.
 *  - With the notes dock in the same row (dockLayout): the session area's
 *    reserve comes first, then the main agent column narrows to DOCK_MIN,
 *    then the notes dock narrows to its own minimum (300); if it still does
 *    not fit, the notes dock yields (kept mounted, not shown) and the column
 *    says so with a one-click way back. Nothing is squeezed below its minimum.
 *  - Open + width persist per device (localStorage), like the sidebar width.
 */

export const DOCK_MIN = 320;
export const DOCK_MAX = 560;
export const DOCK_DEFAULT = 400;
/** Space the column always leaves to the session area (conversation 320 + workspace handle 6 + panel 320). */
export const DETAIL_RESERVE = 646;
/** The column's own resize separator. */
export const DOCK_HANDLE = 6;
export const DOCK_MIN_ROW = DOCK_MIN + DOCK_HANDLE + DETAIL_RESERVE;
export const DOCK_KEY_STEP = 16;
export const DOCK_KEY_STEP_LARGE = 64;
/** Dragging the column narrower than this collapses it on release (stored width kept). */
export const DOCK_COLLAPSE_THRESHOLD = 200;

export const DOCK_STORAGE_KEY = 'vh.main-agent-dock.v1';

export type DockPrefs = { open: boolean; width: number | null };

export function canDock(desktop: boolean, rowWidth: number): boolean {
    return desktop && Number.isFinite(rowWidth) && rowWidth >= DOCK_MIN_ROW;
}

export function dockMaxWidth(rowWidth: number): number {
    return Math.max(DOCK_MIN, Math.min(DOCK_MAX, Math.floor(rowWidth - DOCK_HANDLE - DETAIL_RESERVE)));
}

export function clampDockWidth(px: number | null | undefined, rowWidth: number): number {
    const w = px == null || !Number.isFinite(px) ? DOCK_DEFAULT : Math.round(px);
    return Math.min(dockMaxWidth(rowWidth), Math.max(DOCK_MIN, w));
}

/** Notes dock (screens/notes/notesPanelWidth.ts NOTES_PANEL_MIN) and its separator. */
export const NOTES_MIN = 300;
export const NOTES_HANDLE = 6;

export type DockLayout = {
    /** the main agent column's width */
    dock: number;
    /** notes dock: not in the row | its max-width (≤ its own width) | hidden while the column shows */
    notes: { kind: 'none' } | { kind: 'fit'; maxWidth: number } | { kind: 'yield' };
};

/**
 * Widths for the main agent column and (if it sits in the same row) the
 * notes dock. `notesWidth` = the notes dock's own width when it is in the
 * row, else null. Priority: session area (DETAIL_RESERVE) > main agent
 * column (≥ DOCK_MIN) > notes dock (≥ NOTES_MIN, else it yields).
 */
export function dockLayout(rowWidth: number, stored: number | null | undefined, notesWidth: number | null): DockLayout {
    const preferred = clampDockWidth(stored, rowWidth);
    if (notesWidth === null || !Number.isFinite(notesWidth)) return { dock: preferred, notes: { kind: 'none' } };
    const room = Math.floor(rowWidth - DETAIL_RESERVE - DOCK_HANDLE - NOTES_HANDLE);
    const notes = Math.max(NOTES_MIN, Math.round(notesWidth));
    if (preferred + notes <= room) return { dock: preferred, notes: { kind: 'fit', maxWidth: notes } };
    const dock = Math.max(DOCK_MIN, Math.min(preferred, room - notes));
    const notesFit = room - dock;
    if (notesFit >= NOTES_MIN) return { dock, notes: { kind: 'fit', maxWidth: Math.min(notes, notesFit) } };
    return { dock: preferred, notes: { kind: 'yield' } };
}

/** The column is anchored to the row's right edge: width = edge − pointer (raw, for the collapse check). */
export function dockRawWidthFromPointer(clientX: number, rowRight: number): number {
    return rowRight - clientX;
}

export function shouldCollapseDock(rawWidth: number): boolean {
    return Number.isFinite(rawWidth) && rawWidth < DOCK_COLLAPSE_THRESHOLD;
}

/** Separator on the column's LEFT edge: ArrowLeft = wider. Home/End = min/max. null = not ours. */
export function dockKeyboardWidth(current: number, key: string, shiftKey: boolean, rowWidth: number): number | null {
    const step = shiftKey ? DOCK_KEY_STEP_LARGE : DOCK_KEY_STEP;
    switch (key) {
        case 'ArrowLeft': return clampDockWidth(current + step, rowWidth);
        case 'ArrowRight': return clampDockWidth(current - step, rowWidth);
        case 'Home': return DOCK_MIN;
        case 'End': return dockMaxWidth(rowWidth);
        default: return null;
    }
}

export function parseDockPrefs(raw: string | null): DockPrefs {
    if (!raw) return { open: false, width: null };
    try {
        const v = JSON.parse(raw) as { open?: unknown; width?: unknown };
        const width = typeof v.width === 'number' && Number.isFinite(v.width) && v.width >= DOCK_MIN && v.width <= DOCK_MAX ? Math.round(v.width) : null;
        return { open: v.open === true, width };
    } catch {
        return { open: false, width: null };
    }
}

export function readDockPrefs(): DockPrefs {
    try { return parseDockPrefs(globalThis.localStorage?.getItem(DOCK_STORAGE_KEY) ?? null); } catch { return { open: false, width: null }; }
}

export function writeDockPrefs(prefs: DockPrefs): void {
    try { globalThis.localStorage?.setItem(DOCK_STORAGE_KEY, JSON.stringify(prefs)); } catch { /* private mode: per-session only */ }
}
