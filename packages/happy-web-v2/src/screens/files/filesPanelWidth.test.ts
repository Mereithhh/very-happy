import { describe, it, expect } from 'vitest';
import {
    FILES_PANEL_MIN,
    filesPanelMaxWidth,
    clampFilesPanelWidth,
    filesPanelDefaultWidth,
    resolveFilesPanelWidth,
    filesPanelWidthFromPointer,
    filesPanelPastDeadZone,
    shouldCollapseFilesPanel,
    filesPanelKeyboardWidth,
    FILES_PANEL_COLLAPSE_THRESHOLD,
} from './filesPanelWidth';

describe('filesPanelMaxWidth', () => {
    it('is 60% of the viewport, floored', () => {
        expect(filesPanelMaxWidth(1000)).toBe(600);
        expect(filesPanelMaxWidth(1001)).toBe(600);
    });
    it('never drops below MIN on tiny viewports', () => {
        expect(filesPanelMaxWidth(300)).toBe(FILES_PANEL_MIN);
        expect(filesPanelMaxWidth(0)).toBe(FILES_PANEL_MIN);
    });
});

describe('clampFilesPanelWidth', () => {
    it('passes through in-range widths (rounded)', () => {
        expect(clampFilesPanelWidth(400, 1440)).toBe(400);
        expect(clampFilesPanelWidth(400.6, 1440)).toBe(401);
    });
    it('clamps below MIN up to MIN', () => {
        expect(clampFilesPanelWidth(10, 1440)).toBe(FILES_PANEL_MIN);
        expect(clampFilesPanelWidth(-50, 1440)).toBe(FILES_PANEL_MIN);
    });
    it('clamps above the 60vw cap down to it', () => {
        expect(clampFilesPanelWidth(2000, 1440)).toBe(864); // floor(1440*0.6)
    });
    it('non-finite input falls back to the responsive default', () => {
        expect(clampFilesPanelWidth(NaN, 1440)).toBe(filesPanelDefaultWidth(1440));
        expect(clampFilesPanelWidth(Infinity, 1440)).toBe(filesPanelDefaultWidth(1440));
    });
});

describe('filesPanelDefaultWidth', () => {
    it('uses 36vw on roomy viewports', () => {
        expect(filesPanelDefaultWidth(1440)).toBe(518);
    });
    it('keeps a readable minimum on narrow viewports', () => {
        expect(filesPanelDefaultWidth(880)).toBe(320);
    });
    it('never drops below MIN', () => {
        expect(filesPanelDefaultWidth(400)).toBe(FILES_PANEL_MIN);
    });
});

describe('resolveFilesPanelWidth', () => {
    it('null / undefined = responsive default', () => {
        expect(resolveFilesPanelWidth(null, 1440)).toBe(518);
        expect(resolveFilesPanelWidth(undefined, 1440)).toBe(518);
    });
    it('garbage stored values = responsive default (corrupted blob safety)', () => {
        expect(resolveFilesPanelWidth(NaN, 1440)).toBe(518);
    });
    it('stored width clamps against the CURRENT viewport (big-monitor value on a laptop)', () => {
        expect(resolveFilesPanelWidth(1500, 1280)).toBe(768); // floor(1280*0.6)
        expect(resolveFilesPanelWidth(320, 1280)).toBe(320);
    });
});

describe('filesPanelWidthFromPointer', () => {
    it('width = panel right edge minus pointer x (right-anchored panel)', () => {
        expect(filesPanelWidthFromPointer(1000, 1440, 1440)).toBe(440);
    });
    it('dragging past the right edge clamps to MIN, past 60vw clamps to max', () => {
        expect(filesPanelWidthFromPointer(1430, 1440, 1440)).toBe(FILES_PANEL_MIN);
        expect(filesPanelWidthFromPointer(0, 1440, 1440)).toBe(864);
    });
});

describe('B-609 drag dead zone', () => {
    it('ignores jitter up to 4px so a double-click never resizes', () => {
        expect(filesPanelPastDeadZone(100, 100, 103, 102)).toBe(false);
        expect(filesPanelPastDeadZone(100, 100, 96, 100)).toBe(false);
        expect(filesPanelPastDeadZone(100, 100, 95, 100)).toBe(true);
    });
});

describe('B-609 shouldCollapseFilesPanel', () => {
    it('arms only below the threshold, which sits past the 320px minimum', () => {
        expect(FILES_PANEL_COLLAPSE_THRESHOLD).toBeLessThan(FILES_PANEL_MIN);
        expect(shouldCollapseFilesPanel(320, true)).toBe(false);
        expect(shouldCollapseFilesPanel(200, true)).toBe(false);
        expect(shouldCollapseFilesPanel(199, true)).toBe(true);
        expect(shouldCollapseFilesPanel(-40, true)).toBe(true);
    });
    it('never collapses a host without a close path or on garbage input', () => {
        expect(shouldCollapseFilesPanel(50, false)).toBe(false);
        expect(shouldCollapseFilesPanel(NaN, true)).toBe(false);
    });
});

describe('B-609 filesPanelKeyboardWidth', () => {
    it('ArrowLeft widens and ArrowRight narrows by 16px, Shift by 64px', () => {
        expect(filesPanelKeyboardWidth(500, 'ArrowLeft', false, 1440)).toBe(516);
        expect(filesPanelKeyboardWidth(500, 'ArrowRight', false, 1440)).toBe(484);
        expect(filesPanelKeyboardWidth(500, 'ArrowLeft', true, 1440)).toBe(564);
        expect(filesPanelKeyboardWidth(500, 'ArrowRight', true, 1440)).toBe(436);
    });
    it('clamps steps and maps Home/End to the aria min/max', () => {
        expect(filesPanelKeyboardWidth(330, 'ArrowRight', true, 1440)).toBe(FILES_PANEL_MIN);
        expect(filesPanelKeyboardWidth(860, 'ArrowLeft', true, 1440)).toBe(864);
        expect(filesPanelKeyboardWidth(500, 'Home', false, 1440)).toBe(FILES_PANEL_MIN);
        expect(filesPanelKeyboardWidth(500, 'End', false, 1440)).toBe(864);
    });
    it('leaves other keys to the page', () => {
        expect(filesPanelKeyboardWidth(500, 'ArrowUp', false, 1440)).toBeNull();
        expect(filesPanelKeyboardWidth(500, 'Enter', false, 1440)).toBeNull();
    });
});
