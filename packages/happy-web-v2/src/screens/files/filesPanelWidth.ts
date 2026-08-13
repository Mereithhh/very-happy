/**
 * filesPanelWidth — pure width math for the right-hand files panel shared by
 * BOTH hosts (the session FilesPanel sidebar and the terminal's file browser,
 * B-088). One localSettings field (`filesPanelWidth`) backs both, so dragging
 * in one host resizes the other too.
 *
 * Contract mirrors the AppLayout sidebar precedent (useSidebarPrefs):
 * - null / non-finite stored value = responsive default (the pre-B-088 CSS
 *   default: 380px capped at 42vw), NOT a hard pixel count.
 * - user-dragged widths clamp to [MIN, 60vw] against the CURRENT viewport;
 *   the hosts additionally keep a CSS `max-width: 60vw` belt so a width
 *   stored on a large monitor can't crush the main pane on a small one.
 */

export const FILES_PANEL_MIN = 280;
export const FILES_PANEL_DEFAULT = 380;
/** Dragging may take at most this fraction of the viewport. */
export const FILES_PANEL_MAX_FRACTION = 0.6;
/** The responsive DEFAULT (null) caps lower — the historical 42vw. */
export const FILES_PANEL_DEFAULT_FRACTION = 0.42;

/** Largest width a drag may produce on this viewport (never below MIN). */
export function filesPanelMaxWidth(viewportWidth: number): number {
    return Math.max(FILES_PANEL_MIN, Math.floor(viewportWidth * FILES_PANEL_MAX_FRACTION));
}

/** Clamp a candidate width into [MIN, max-for-viewport], rounded to px. */
export function clampFilesPanelWidth(px: number, viewportWidth: number): number {
    if (!Number.isFinite(px)) return filesPanelDefaultWidth(viewportWidth);
    return Math.min(filesPanelMaxWidth(viewportWidth), Math.max(FILES_PANEL_MIN, Math.round(px)));
}

/** Responsive default: 380px, capped at 42vw (the pre-drag CSS behavior). */
export function filesPanelDefaultWidth(viewportWidth: number): number {
    const capped = Math.min(FILES_PANEL_DEFAULT, Math.floor(viewportWidth * FILES_PANEL_DEFAULT_FRACTION));
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
