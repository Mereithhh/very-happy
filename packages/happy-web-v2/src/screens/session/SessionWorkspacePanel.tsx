import { Globe } from 'lucide-react';
import { BrowserPreview } from '../workspace/BrowserPreview';
import { useEffect, useRef } from 'react';
import { useMessage, useSession } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { FilesPanel } from './FilesPanel';
import { BtwPanel } from './BtwPanel';
import { SubagentPanel } from './SubagentPanel';
import { buildSubagentSummary } from './subagentSummary';
import { useNotesWorkspace } from '../notes/useNotesWorkspace';
import { setNotesPanelOpen } from '../notes/notesPanelState';
import { OrderedWorkspaceTabs } from '../workspace/OrderedWorkspaceTabs';
import { WorkspacePane } from '../workspace/WorkspacePane';
import { useWorkspaceView } from '../workspace/workspaceViewStore';
import { closeWorkspaceTab, openWorkspaceTab, moveWorkspaceTab, type WorkspaceTab } from '../workspace/workspaceTabModel';
import './session.css';
import type { SessionFilesTab, SessionPanelTab } from './sessionPanelState';

/** One tab strip, preserving existing URL deep links and each content owner. */
export function SessionWorkspacePanel({ sessionId, panel, subagentTarget, btwAllowed, visible = true, refreshOnMount = true, onPanel, onSubagent, onClose }: {
  sessionId: string; panel: SessionPanelTab; subagentTarget: string | null; btwAllowed: boolean;
  visible?: boolean; refreshOnMount?: boolean;
  onPanel: (panel: SessionPanelTab) => void; onSubagent: (id: string) => void; onClose: () => void;
}) {
  const { t,lang } = useTranslation();
  const session = useSession(sessionId);
  const subagentMessage = useMessage(sessionId, subagentTarget ?? '');
  const agentTitle = subagentMessage?.kind === 'tool-call' ? buildSubagentSummary(subagentMessage).title : null;
  const identity = JSON.stringify(['session-tools', sessionId, session?.metadata?.machineId, session?.metadata?.path]);
  const [tools, updateTools] = useWorkspaceView(identity);
  const filesTab = useRef<SessionFilesTab>('changed');
  const notes = useNotesWorkspace(visible && panel === 'notes');
  const filesActive = visible && panel !== 'btw' && panel !== 'subagent' && panel !== 'notes' && panel !== 'web';
  if (filesActive) filesTab.current = panel;
  const activeTool = panel === 'web' ? 'web' : panel === 'notes' ? 'notes' : panel === 'btw' && btwAllowed ? 'btw' : panel === 'subagent' && subagentTarget ? `agent:${subagentTarget}` : null;
  const current: WorkspaceTab | null = activeTool ? { id:activeTool, title: panel === 'web' ? (lang.startsWith('zh')?'网页预览':'Web preview') : panel === 'notes' ? t('notes.title') : panel === 'btw' ? t('session.btw.title') : agentTitle || t('session.chat.subagentPanelTitle') } : null;
  // Include a just-opened URL target immediately; persist after render.
  const tabs = (current && !tools.tabs.some(tab => tab.id === current.id) ? [...tools.tabs,current] : tools.tabs).filter(tab => tab.id !== 'btw' || btwAllowed);
  useEffect(() => {
    if (current) updateTools(state => openWorkspaceTab(state,current));
  }, [identity, activeTool, current?.title]);
  const selectTool = (id:string) => id === 'web' ? onPanel('web') : id === 'notes' ? onPanel('notes') : id === 'btw' ? onPanel('btw') : onSubagent(id.slice(6));
  const closeTool = (id:string) => {
    if(id==='notes') setNotesPanelOpen(false);
    updateTools(state => closeWorkspaceTab(state,id));
    if (activeTool === id) {
      const remaining = tabs.filter(tab => tab.id !== id);
      if (remaining.length) selectTool(remaining[remaining.length-1].id);
      else onPanel(filesTab.current);
    }
  };
  return <FilesPanel sessionId={sessionId} tab={filesTab.current} active={filesActive}
    refreshOnMount={refreshOnMount && filesActive} onTabChange={onPanel} onClose={onClose}
    renderTabs={fileProps => <OrderedWorkspaceTabs identity={identity} {...fileProps}
      tabs={[...fileProps.tabs,...tabs.filter(tab=>tab.id!=='notes').map(tab=>({...tab,id:`extra:${tab.id}`,group:'tools'})),...(tabs.some(tab=>tab.id==='notes')?notes.tabProps.tabs.map(tab=>({...tab,id:`notes:${tab.id}`,closable:true})):[])]}
      active={activeTool==='notes'?`notes:${notes.tabProps.active}`:activeTool ? `extra:${activeTool}` : fileProps.active}
      actions={<><button className="fp-icon" onClick={()=>onPanel('web')} aria-label={lang.startsWith('zh')?'网页预览':'Web preview'} title={lang.startsWith('zh')?'网页预览':'Web preview'}><Globe size={15}/></button>{activeTool==='notes'&&notes.actions}{fileProps.actions}</>}
      onSelect={id=>{
        if(id.startsWith('notes:')) { notes.tabProps.onSelect(id.slice(6)); onPanel('notes'); }
        else if(id.startsWith('extra:')) selectTool(id.slice(6));
        else { fileProps.onSelect(id); if(id.startsWith('file:')) onPanel(filesTab.current); }
      }}
      onCloseOthers={id=>{
        updateTools(state=>({...state,tabs:state.tabs.filter(tab=>id.startsWith('notes:')?tab.id==='notes':`extra:${tab.id}`===id),active:id.startsWith('notes:')?'notes':id.startsWith('extra:')?id.slice(6):null}));
        if(tabs.some(tab=>tab.id==='notes')) notes.tabProps.tabs.filter(tab=>tab.closable!==false&&`notes:${tab.id}`!==id).forEach(tab=>notes.tabProps.onClose(tab.id));
        fileProps.tabs.filter(tab=>tab.closable!==false&&tab.id!==id).forEach(tab=>fileProps.onClose(tab.id));
        if(id.startsWith('notes:')) { notes.tabProps.onSelect(id.slice(6)); onPanel('notes'); }
        else if(id.startsWith('extra:')) selectTool(id.slice(6));
        else { fileProps.onSelect(id); if(id.startsWith('file:')) onPanel(filesTab.current); }
      }}
      onClose={id=>id==='notes:list'?closeTool('notes'):id.startsWith('notes:')?notes.tabProps.onClose(id.slice(6)):id.startsWith('extra:')?closeTool(id.slice(6)):fileProps.onClose(id)}
      onMove={(id,target)=>{
        if(id.startsWith('notes:')&&target.startsWith('notes:')) notes.tabProps.onMove(id.slice(6),target.slice(6));
        else if(id.startsWith('extra:')&&target.startsWith('extra:')) updateTools(state=>moveWorkspaceTab(state,id.slice(6),target.slice(6)));
        else fileProps.onMove(id,target);
      }}
    />}>
    {tabs.map(tab=><WorkspacePane key={`${identity}:${tab.id}`} className="session-workspace-pane" active={visible && activeTool===tab.id} order={tabs.map(tab=>tab.id).join('\n')}>
      {tab.id==='web'?<BrowserPreview identity={identity}/>:tab.id==='notes'?notes.content:tab.id==='btw'
        ? <BtwPanel sessionId={sessionId} embedded active={visible && activeTool===tab.id} onClose={()=>closeTool(tab.id)}/>
        : <SubagentPanel sessionId={sessionId} messageId={tab.id.slice(6)} embedded onClose={()=>closeTool(tab.id)}/>}
    </WorkspacePane>)}
  </FilesPanel>;
}
