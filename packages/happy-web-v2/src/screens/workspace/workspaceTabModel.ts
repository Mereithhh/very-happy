export interface WorkspaceTab { id: string; title: string; description?: string; closable?: boolean; movable?: boolean; group?: string }
export interface WorkspaceTabsState { tabs: WorkspaceTab[]; active: string | null }

export function openWorkspaceTab(state: WorkspaceTabsState, tab: WorkspaceTab): WorkspaceTabsState {
  const existing = state.tabs.findIndex(item => item.id === tab.id);
  return { tabs: existing < 0 ? [...state.tabs, tab] : state.tabs.map(item => item.id === tab.id ? tab : item), active: tab.id };
}
export function closeWorkspaceTab(state: WorkspaceTabsState, id: string): WorkspaceTabsState {
  const index = state.tabs.findIndex(tab => tab.id === id);
  if (index < 0 || state.tabs[index].closable === false) return state;
  const tabs = state.tabs.filter(tab => tab.id !== id);
  return { tabs, active: state.active === id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : state.active };
}
export function moveWorkspaceTab(state: WorkspaceTabsState, id: string, target: string): WorkspaceTabsState {
  const from = state.tabs.findIndex(tab => tab.id === id);
  const to = state.tabs.findIndex(tab => tab.id === target);
  if (from < 0 || to < 0 || from === to) return state;
  const tabs = [...state.tabs];
  tabs.splice(to, 0, tabs.splice(from, 1)[0]);
  return { ...state, tabs };
}
