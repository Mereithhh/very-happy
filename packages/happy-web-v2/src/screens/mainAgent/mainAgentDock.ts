/**
 * B-923: the main agent as a column of the desktop layout (it used to be a
 * floating drawer). Pure width / availability / persistence rules:
 *
 *  - The column lives at the right end of the shell's main row (detail |
 *    notes | main agent). It squeezes the session area, never covers it.
 *  - It docks only when the main row is at least DOCK_MIN_ROW wide (sidebar
 *    excluded); narrower windows and phones open the full-screen
 *    /main-agent page instead, as before.
 *  - Width: [DOCK_MIN, min(DOCK_MAX, row − DETAIL_RESERVE)]. The session
 *    area therefore keeps ≥ DETAIL_RESERVE (640px): its own right-hand
 *    workspace panel (files / preview / board) caps itself at "container −
 *    320px" (session.css .sd-files), so conversation and workspace panel
 *    keep ≥ 320px each. Nothing overlaps and the row never scrolls sideways.
 *  - Open + width persist per device (localStorage), like the sidebar width.
 */

export const DOCK_MIN = 320;
export const DOCK_MAX = 560;
export const DOCK_DEFAULT = 400;
/** Space the column always leaves to the session area (conversation 320 + workspace panel 320). */
export const DETAIL_RESERVE = 640;
export const DOCK_MIN_ROW = DOCK_MIN + DETAIL_RESERVE;
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
    return Math.max(DOCK_MIN, Math.min(DOCK_MAX, Math.floor(rowWidth - DETAIL_RESERVE)));
}

export function clampDockWidth(px: number | null | undefined, rowWidth: number): number {
    const w = px == null || !Number.isFinite(px) ? DOCK_DEFAULT : Math.round(px);
    return Math.min(dockMaxWidth(rowWidth), Math.max(DOCK_MIN, w));
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
