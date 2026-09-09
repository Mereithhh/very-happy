import type { ComponentProps } from 'react';
import { WorkspaceTabs } from './WorkspaceTabs';
import { useWorkspaceView } from './workspaceViewStore';
import { moveWorkspaceTab, type WorkspaceTab } from './workspaceTabModel';

/** Overlay display order without transferring ownership of files, notes or tools. */
export function orderWorkspaceTabs(tabs: WorkspaceTab[], preferred: readonly string[]): WorkspaceTab[] {
  const byId = new Map(tabs.map(tab => [tab.id, tab]));
  const ordered: WorkspaceTab[] = [];
  for (const id of preferred) { const tab = byId.get(id); if (tab) { ordered.push(tab); byId.delete(id); } }
  return [...ordered, ...byId.values()];
}
export function OrderedWorkspaceTabs({ identity, ...props }: ComponentProps<typeof WorkspaceTabs> & { identity: string }) {
  const [saved, save] = useWorkspaceView(`tab-order:${identity}`);
  const fixed = props.tabs.filter(tab => tab.movable === false);
  const movable = orderWorkspaceTabs(props.tabs.filter(tab => tab.movable !== false), saved.tabs.map(tab => tab.id));
  return <WorkspaceTabs {...props} tabs={[...fixed, ...movable.map(tab => ({...tab, group:'workspace'}))]}
    onMove={(id,target)=>{
      const from = props.tabs.find(tab=>tab.id===id), to = props.tabs.find(tab=>tab.id===target);
      if (!from || !to || from.movable===false || to.movable===false) return;
      const next=moveWorkspaceTab({tabs:movable,active:props.active},id,target);
      save(()=>({tabs:next.tabs.map(tab=>({id:tab.id,title:tab.id})),active:null}));
      // Preserve each owner's established ordering for moves within that owner.
      if(from.group===to.group) props.onMove(id,target);
    }}/>;
}
