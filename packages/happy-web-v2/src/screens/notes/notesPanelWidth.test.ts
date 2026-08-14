import { describe, expect, it } from 'vitest';
import {
    NOTES_PANEL_DEFAULT,
    NOTES_PANEL_MIN,
    clampNotesPanelWidth,
    notesPanelMaxWidth,
    notesPanelWidthFromPointer,
    resolveNotesPanelWidth,
} from './notesPanelWidth';

describe('notesPanelWidth', () => {
    it('max is half the viewport but never below MIN', () => {
        expect(notesPanelMaxWidth(1600)).toBe(800);
        expect(notesPanelMaxWidth(400)).toBe(NOTES_PANEL_MIN);
    });

    it('clamps into [MIN, max] and rounds', () => {
        expect(clampNotesPanelWidth(10, 1600)).toBe(NOTES_PANEL_MIN);
        expect(clampNotesPanelWidth(5000, 1600)).toBe(800);
        expect(clampNotesPanelWidth(410.6, 1600)).toBe(411);
        expect(clampNotesPanelWidth(NaN, 1600)).toBe(NOTES_PANEL_DEFAULT);
    });

    it('resolve: null/undefined → default; stored values re-clamped for this screen', () => {
        expect(resolveNotesPanelWidth(null, 1600)).toBe(NOTES_PANEL_DEFAULT);
        expect(resolveNotesPanelWidth(undefined, 1600)).toBe(NOTES_PANEL_DEFAULT);
        expect(resolveNotesPanelWidth(700, 1000)).toBe(500); // saved on a wide screen, opened on a narrow one
    });

    it('pointer math is right-anchored (width = rightEdge − clientX)', () => {
        expect(notesPanelWidthFromPointer(1000, 1400, 1600)).toBe(400);
        expect(notesPanelWidthFromPointer(1390, 1400, 1600)).toBe(NOTES_PANEL_MIN);
        expect(notesPanelWidthFromPointer(0, 1400, 1600)).toBe(800);
    });
});
