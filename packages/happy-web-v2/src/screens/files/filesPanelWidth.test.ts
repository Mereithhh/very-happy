import { describe, it, expect } from 'vitest';
import {
    FILES_PANEL_MIN,
    FILES_PANEL_DEFAULT,
    filesPanelMaxWidth,
    clampFilesPanelWidth,
    filesPanelDefaultWidth,
    resolveFilesPanelWidth,
    filesPanelWidthFromPointer,
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
    it('is 380px on roomy viewports', () => {
        expect(filesPanelDefaultWidth(1440)).toBe(FILES_PANEL_DEFAULT);
    });
    it('caps at 42vw on narrow viewports (pre-B-088 CSS behavior)', () => {
        expect(filesPanelDefaultWidth(880)).toBe(Math.floor(880 * 0.42));
    });
    it('never drops below MIN', () => {
        expect(filesPanelDefaultWidth(400)).toBe(FILES_PANEL_MIN);
    });
});

describe('resolveFilesPanelWidth', () => {
    it('null / undefined = responsive default', () => {
        expect(resolveFilesPanelWidth(null, 1440)).toBe(FILES_PANEL_DEFAULT);
        expect(resolveFilesPanelWidth(undefined, 1440)).toBe(FILES_PANEL_DEFAULT);
    });
    it('garbage stored values = responsive default (corrupted blob safety)', () => {
        expect(resolveFilesPanelWidth(NaN, 1440)).toBe(FILES_PANEL_DEFAULT);
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
