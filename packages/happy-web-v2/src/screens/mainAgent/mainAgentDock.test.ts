import { describe, expect, it } from 'vitest';
import { canDock, clampDockWidth, DETAIL_RESERVE, DOCK_HANDLE, DOCK_DEFAULT, DOCK_MAX, DOCK_MIN, DOCK_MIN_ROW, dockKeyboardWidth, dockLayout, dockMaxWidth, NOTES_MIN, NOTES_HANDLE, parseDockPrefs, shouldCollapseDock } from './mainAgentDock';

describe('main agent column rules (B-923)', () => {
    it('docks only on desktop with room for the column and 640px of session area', () => {
        expect(DOCK_MIN_ROW).toBe(DOCK_MIN + DOCK_HANDLE + DETAIL_RESERVE);
        expect(canDock(true, DOCK_MIN_ROW)).toBe(true);
        expect(canDock(true, DOCK_MIN_ROW - 1)).toBe(false);
        expect(canDock(false, 3000)).toBe(false);
        expect(canDock(true, Number.NaN)).toBe(false);
    });

    it('width never takes the session area below the reserve (1280 / 1440 / 1920 with a 260px sidebar)', () => {
        for (const viewport of [1280, 1440, 1920]) {
            const row = viewport - 266;
            for (const stored of [null, 100, DOCK_DEFAULT, 9999]) {
                const w = clampDockWidth(stored, row);
                expect(w).toBeGreaterThanOrEqual(DOCK_MIN);
                expect(w).toBeLessThanOrEqual(DOCK_MAX);
                expect(row - w - DOCK_HANDLE).toBeGreaterThanOrEqual(DETAIL_RESERVE);
            }
        }
        expect(clampDockWidth(null, 3000)).toBe(DOCK_DEFAULT);
        // the 1280 row (1014) caps the column at 362 so the session keeps 646
        expect(dockMaxWidth(1014)).toBe(362);
        expect(clampDockWidth(DOCK_DEFAULT, 1014)).toBe(362);
    });

    it('keyboard and collapse', () => {
        expect(dockKeyboardWidth(400, 'ArrowLeft', false, 2000)).toBe(416);
        expect(dockKeyboardWidth(400, 'ArrowRight', true, 2000)).toBe(336);
        expect(dockKeyboardWidth(400, 'Home', false, 2000)).toBe(DOCK_MIN);
        expect(dockKeyboardWidth(400, 'End', false, 2000)).toBe(DOCK_MAX);
        expect(dockKeyboardWidth(400, 'a', false, 2000)).toBeNull();
        expect(shouldCollapseDock(150)).toBe(true);
        expect(shouldCollapseDock(250)).toBe(false);
    });

    it('persisted prefs parse defensively', () => {
        expect(parseDockPrefs(null)).toEqual({ open: false, width: null });
        expect(parseDockPrefs('{"open":true,"width":420}')).toEqual({ open: true, width: 420 });
        expect(parseDockPrefs('{"open":"yes","width":99999}')).toEqual({ open: false, width: null });
        expect(parseDockPrefs('nope')).toEqual({ open: false, width: null });
    });

    it('with the notes dock in the row: column narrows first, then notes, then notes yields (1280 / 1440 / 1920)', () => {
        const SIDEBAR = 266;
        for (const viewport of [1280, 1440, 1920]) {
            const row = viewport - SIDEBAR;
            for (const notes of [300, 380, 700]) {
                for (const stored of [null, 320, 560]) {
                    const l = dockLayout(row, stored, notes);
                    expect(l.dock).toBeGreaterThanOrEqual(DOCK_MIN);
                    if (l.notes.kind === 'fit') {
                        expect(l.notes.maxWidth).toBeGreaterThanOrEqual(NOTES_MIN);
                        // detail + both handles + both panels fit in the row: no overlap, no horizontal scroll
                        expect(DETAIL_RESERVE + DOCK_HANDLE + l.dock + NOTES_HANDLE + l.notes.maxWidth).toBeLessThanOrEqual(row);
                    } else {
                        expect(l.notes.kind).toBe('yield');
                        expect(DETAIL_RESERVE + DOCK_HANDLE + l.dock).toBeLessThanOrEqual(row);
                    }
                }
            }
        }
        // 1440 (row 1174): 522px after the reserve — the notes dock cannot keep 300 next to a 320 column → it yields
        expect(dockLayout(1174, null, 380)).toEqual({ dock: 400, notes: { kind: 'yield' } });
        // 1920 (row 1654): both fit at their own widths
        expect(dockLayout(1654, null, 380)).toEqual({ dock: 400, notes: { kind: 'fit', maxWidth: 380 } });
        // a wide notes dock first narrows the column, then itself
        expect(dockLayout(1654, 560, 700)).toEqual({ dock: 320, notes: { kind: 'fit', maxWidth: 676 } });
        // a mid-size row: the column gives up 38px so the notes dock keeps its own width
        expect(dockLayout(1400, 400, 380)).toEqual({ dock: 362, notes: { kind: 'fit', maxWidth: 380 } });
        expect(dockLayout(1174, null, null)).toEqual({ dock: 400, notes: { kind: 'none' } });
    });
});
