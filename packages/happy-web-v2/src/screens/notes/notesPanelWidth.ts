/**
 * notesPanelWidth — pure width math for the notes dock (B-094). Same shape as
 * filesPanelWidth.ts (right-anchored drag), separate constants so the two
 * panels can diverge without coupling.
 */

export const NOTES_PANEL_MIN = 300;
export const NOTES_PANEL_DEFAULT = 380;
/** hard drag ceiling: half the viewport (the work stays the main character) */
export const NOTES_PANEL_MAX_FRACTION = 0.5;

export function notesPanelMaxWidth(viewportWidth: number): number {
    return Math.max(NOTES_PANEL_MIN, Math.floor(viewportWidth * NOTES_PANEL_MAX_FRACTION));
}

export function clampNotesPanelWidth(px: number, viewportWidth: number): number {
    if (!Number.isFinite(px)) return NOTES_PANEL_DEFAULT;
    return Math.min(Math.max(Math.round(px), NOTES_PANEL_MIN), notesPanelMaxWidth(viewportWidth));
}

/** Width to render for a stored preference (null = default, still clamped). */
export function resolveNotesPanelWidth(stored: number | null | undefined, viewportWidth: number): number {
    if (stored === null || stored === undefined) {
        return clampNotesPanelWidth(NOTES_PANEL_DEFAULT, viewportWidth);
    }
    return clampNotesPanelWidth(stored, viewportWidth);
}

/**
 * Pointer → width. The dock is right-anchored: its right edge is fixed while
 * dragging, the pointer moves the LEFT edge, so width = rightEdge − clientX.
 */
export function notesPanelWidthFromPointer(clientX: number, panelRightEdge: number, viewportWidth: number): number {
    return clampNotesPanelWidth(panelRightEdge - clientX, viewportWidth);
}
