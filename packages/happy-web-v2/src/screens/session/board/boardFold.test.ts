import { describe, expect, it } from 'vitest';
import { boardFoldAction } from './boardFold';

describe('boardFoldAction', () => {
    it('unfolding with the sheet open moves the board to the aside', () => {
        expect(boardFoldAction(true, false, { sheetOpen: true, panelIsBoard: false })).toBe('sheet-to-panel');
    });
    it('folding with the board aside open drops it as the sheet', () => {
        expect(boardFoldAction(false, true, { sheetOpen: false, panelIsBoard: true })).toBe('panel-to-sheet');
    });
    it('acts only on a crossing, and only when the board is on screen', () => {
        expect(boardFoldAction(true, true, { sheetOpen: false, panelIsBoard: true })).toBe('none');
        expect(boardFoldAction(false, false, { sheetOpen: true, panelIsBoard: false })).toBe('none');
        expect(boardFoldAction(true, false, { sheetOpen: false, panelIsBoard: false })).toBe('none');
        expect(boardFoldAction(false, true, { sheetOpen: false, panelIsBoard: false })).toBe('none');
    });
});
