import { useSyncExternalStore } from 'react';
import type { WorkspaceTabsState } from './workspaceTabModel';

// View identities only, never file content or drafts. Separate from synced settings.
const views = new Map<string, WorkspaceTabsState>();
const listeners = new Set<() => void>();
const empty: WorkspaceTabsState = { tabs: [], active: null };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function readWorkspaceView(identity: string): WorkspaceTabsState { return views.get(identity) ?? empty; }
export function updateWorkspaceView(identity: string, update: (state: WorkspaceTabsState) => WorkspaceTabsState) {
  const next = update(readWorkspaceView(identity));
  views.set(identity, next);
  listeners.forEach(listener => listener());
}
export function useWorkspaceView(identity: string) {
  const state = useSyncExternalStore(subscribe, () => readWorkspaceView(identity), () => empty);
  return [state, (update: (state: WorkspaceTabsState) => WorkspaceTabsState) => updateWorkspaceView(identity, update)] as const;
}
