/**
 * B-795: the 汇报板 has two homes — the top sheet on phones (<768px) and the
 * `?panel=board` aside elsewhere. A fold / unfold crosses that line with the
 * board on screen; it moves to the other home instead of closing (and an aside
 * that would become a full-screen overlay on the folded phone becomes the sheet).
 * Only the crossing acts: a phone deep link to `?panel=board` keeps its aside.
 */
export type BoardFoldAction = 'none' | 'sheet-to-panel' | 'panel-to-sheet';

export function boardFoldAction(prevPhone: boolean, phone: boolean, state: { sheetOpen: boolean; panelIsBoard: boolean }): BoardFoldAction {
    if (prevPhone === phone) return 'none';
    if (!phone && state.sheetOpen) return 'sheet-to-panel';
    if (phone && state.panelIsBoard) return 'panel-to-sheet';
    return 'none';
}
