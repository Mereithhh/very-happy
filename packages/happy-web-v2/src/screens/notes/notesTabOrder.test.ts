import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  localSettings: { notesOpenTabs: ['a','b','c'], notesActiveTab:'b', notesSplitNote:'a', notesPanelOpen:true },
  applyLocalSettings: vi.fn(),
}));
vi.mock('@/sync/storage', () => ({ storage:{getState:()=>state} }));
import { moveNoteTab } from './notesPanelState';
beforeEach(()=>state.applyLocalSettings.mockClear());
it('moves a pinned note without changing active editor, split view or visibility',()=>{
  moveNoteTab('c','a');
  expect(state.applyLocalSettings).toHaveBeenCalledWith({notesOpenTabs:['c','a','b']});
  expect(state.localSettings.notesOpenTabs).toEqual(['a','b','c']);
});
it('ignores missing and identical note targets',()=>{
  moveNoteTab('missing','a'); moveNoteTab('b','missing'); moveNoteTab('b','b');
  expect(state.applyLocalSettings).not.toHaveBeenCalled();
});
