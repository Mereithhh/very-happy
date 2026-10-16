/**
 * filesPanelWidth — pure width math for the right-hand files panel shared by
 * BOTH hosts (the session FilesPanel sidebar and the terminal's file browser,
 * B-088). One localSettings field (`filesPanelWidth`) backs both, so dragging
 * in one host resizes the other too.
 *
 * Contract mirrors the AppLayout sidebar precedent (useSidebarPrefs):
 * - null / non-finite stored value = responsive default (the pre-B-088 CSS
 *   default: 36vw, at least 320px), NOT a hard pixel count.
 * - user-dragged widths clamp to [MIN, 60vw] against the CURRENT viewport;
 *   the hosts additionally cap against their available container width,
 *   reserving 320px for the main pane when the sidebar is present.
 */

export const FILES_PANEL_MIN = 320;
/** Dragging may take at most this fraction of the viewport. */
export const FILES_PANEL_MAX_FRACTION = 0.6;
/** The responsive default reserves room for the conversation and sidebar. */
export const FILES_PANEL_DEFAULT_FRACTION = 0.36;

/** Largest width a drag may produce on this viewport (never below MIN). */
export function filesPanelMaxWidth(viewportWidth: number): number {
    return Math.max(FILES_PANEL_MIN, Math.floor(viewportWidth * FILES_PANEL_MAX_FRACTION));
}

/** Clamp a candidate width into [MIN, max-for-viewport], rounded to px. */
export function clampFilesPanelWidth(px: number, viewportWidth: number): number {
    if (!Number.isFinite(px)) return filesPanelDefaultWidth(viewportWidth);
    return Math.min(filesPanelMaxWidth(viewportWidth), Math.max(FILES_PANEL_MIN, Math.round(px)));
}

/** Responsive default: 36vw, with a readable 320px minimum. */
export function filesPanelDefaultWidth(viewportWidth: number): number {
    const capped = Math.floor(viewportWidth * FILES_PANEL_DEFAULT_FRACTION);
    return Math.max(FILES_PANEL_MIN, capped);
}

/**
 * Effective width for a stored setting. null (never dragged) and garbage
 * (NaN/Infinity from a corrupted blob) both fall back to the responsive
 * default; real numbers clamp against the current viewport.
 */
export function resolveFilesPanelWidth(stored: number | null | undefined, viewportWidth: number): number {
    if (stored == null || !Number.isFinite(stored)) return filesPanelDefaultWidth(viewportWidth);
    return clampFilesPanelWidth(stored, viewportWidth);
}

/**
 * Width implied by a pointer during a drag: the panel is anchored to the
 * container's RIGHT edge, so width = edge − pointerX (unlike AppLayout's
 * left-anchored sidebar where width = clientX), clamped as usual.
 */
export function filesPanelWidthFromPointer(clientX: number, panelRightEdge: number, viewportWidth: number): number {
    return clampFilesPanelWidth(panelRightEdge - clientX, viewportWidth);
}

/** B-609: pointer travel before a press on the handle becomes a drag (double-click stays a click). */
export const FILES_PANEL_DRAG_DEAD_ZONE = 4;
/**
 * B-609: dragging the panel narrower than this (well past the 320px minimum)
 * arms collapse; releasing there closes the panel instead of resizing it.
 */
export const FILES_PANEL_COLLAPSE_THRESHOLD = 200;
export const FILES_PANEL_KEY_STEP = 16;
export const FILES_PANEL_KEY_STEP_LARGE = 64;

export function filesPanelPastDeadZone(startX: number, startY: number, x: number, y: number): boolean {
    return Math.hypot(x - startX, y - startY) > FILES_PANEL_DRAG_DEAD_ZONE;
}

/**
 * Collapse decision for a drag. `rawWidth` is the UNCLAMPED width the pointer
 * implies (edge − clientX): the rendered width stops at MIN, the pointer
 * does not.
 */
export function shouldCollapseFilesPanel(rawWidth: number, canCollapse: boolean): boolean {
    return canCollapse && Number.isFinite(rawWidth) && rawWidth < FILES_PANEL_COLLAPSE_THRESHOLD;
}

/**
 * Keyboard resize for the separator. The handle sits on the panel's LEFT
 * edge, so ArrowLeft moves it left = wider, ArrowRight = narrower; Shift
 * takes the large step. Home/End jump to the min/max (aria-valuemin/max).
 * Returns null for keys the separator does not own.
 */
export function filesPanelKeyboardWidth(current: number, key: string, shiftKey: boolean, viewportWidth: number): number | null {
    const step = shiftKey ? FILES_PANEL_KEY_STEP_LARGE : FILES_PANEL_KEY_STEP;
    switch (key) {
        case 'ArrowLeft': return clampFilesPanelWidth(current + step, viewportWidth);
        case 'ArrowRight': return clampFilesPanelWidth(current - step, viewportWidth);
        case 'Home': return FILES_PANEL_MIN;
        case 'End': return filesPanelMaxWidth(viewportWidth);
        default: return null;
    }
}
