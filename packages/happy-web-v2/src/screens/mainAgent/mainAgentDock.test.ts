import { describe, expect, it } from 'vitest';
import { canDock, clampDockWidth, DETAIL_RESERVE, DOCK_DEFAULT, DOCK_MAX, DOCK_MIN, DOCK_MIN_ROW, dockKeyboardWidth, dockMaxWidth, parseDockPrefs, shouldCollapseDock } from './mainAgentDock';

describe('main agent column rules (B-923)', () => {
    it('docks only on desktop with room for the column and 640px of session area', () => {
        expect(DOCK_MIN_ROW).toBe(DOCK_MIN + DETAIL_RESERVE);
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
                expect(row - w).toBeGreaterThanOrEqual(DETAIL_RESERVE);
            }
        }
        expect(clampDockWidth(null, 3000)).toBe(DOCK_DEFAULT);
        // the 1280 row (1014) caps the column at 374 so the session keeps 640
        expect(dockMaxWidth(1014)).toBe(374);
        expect(clampDockWidth(DOCK_DEFAULT, 1014)).toBe(374);
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
});
