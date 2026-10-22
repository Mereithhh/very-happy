import { ClipboardList, Copy, FileSearch, Globe, Plus, FolderOpen, Files, GitCompareArrows, MessageCircleQuestion, MonitorPlay, StickyNote } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { MachinePanelFrame } from '../workspace/MachinePanelFrame';
import { parseWebPanels } from '@/sync/webPanels';
import { ActionDropdownMenu } from '@/ui/Menu';
import { BrowserPreview } from '../workspace/BrowserPreview';
import { useEffect, useRef } from 'react';
import { useMachine, useMessage, useSession } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { FilesPanel } from './FilesPanel';
import { BtwPanel } from './BtwPanel';
import { SessionHistoryPanel } from './SessionPreviews';
import { SubagentPanel } from './SubagentPanel';
import { BoardPanel } from './board/BoardPanel';
import { useBoardItems } from './board/boardStore';
import { boardCopy } from './board/boardCopy';
import { buildSubagentSummary } from './subagentSummary';
import { useNotesWorkspace } from '../notes/useNotesWorkspace';
import { setNotesPanelOpen } from '../notes/notesPanelState';
import { OrderedWorkspaceTabs } from '../workspace/OrderedWorkspaceTabs';
import { WorkspacePane } from '../workspace/WorkspacePane';
import { useWorkspaceView } from '../workspace/workspaceViewStore';
import { closeWorkspaceTab, openWorkspaceTab, moveWorkspaceTab, type WorkspaceTab } from '../workspace/workspaceTabModel';
import './session.css';
import { isHistoryPanel, readMachinePanelTarget, withMachinePanel, type SessionFilesTab, type SessionPanelTab } from './sessionPanelState';

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
  const filesTab = useRef<SessionFilesTab>('browse');
  const notes = useNotesWorkspace(visible && panel === 'notes');
  // B-766: the 汇报板 tab exists only for a session that has a board (sync / harness fed).
  const hasBoard = useBoardItems(sessionId) !== undefined;
  const boardTitle = boardCopy(lang.startsWith('zh')).title;
  // B-510: the session machine's declared web panels (`?panel=machine&wp=<id>`).
  const [searchParams, setSearchParams] = useSearchParams();
  const machine = useMachine(session?.metadata?.machineId ?? '');
  const webPanels = parseWebPanels(machine?.daemonState);
  const machinePanelId = panel === 'machine-panel' ? readMachinePanelTarget(searchParams) : null;
  const openMachinePanel = (id: string) => setSearchParams(withMachinePanel(searchParams, id), { replace: true });
  const filesActive = visible && panel !== 'btw' && panel !== 'subagent' && panel !== 'notes' && panel !== 'web' && panel !== 'machine-panel' && panel !== 'board' && !isHistoryPanel(panel);
  if (filesActive) filesTab.current = panel;
  const activeTool = isHistoryPanel(panel) ? panel : panel === 'machine-panel' ? (machinePanelId ? `panel:${machinePanelId}` : null) : panel === 'board' && hasBoard ? 'board' : panel === 'web' ? 'web' : panel === 'notes' ? 'notes' : panel === 'btw' && btwAllowed ? 'btw' : panel === 'subagent' && subagentTarget ? `agent:${subagentTarget}` : null;
  const current: WorkspaceTab | null = activeTool ? { id:activeTool, title: activeTool.startsWith('panel:') ? (webPanels.find(p => `panel:${p.id}` === activeTool)?.title ?? activeTool.slice(6)) : panel === 'previews' ? t('toolHistory.previewsTitle') : panel === 'clipboard' ? t('toolHistory.clipboardTitle') : panel === 'board' ? boardTitle : panel === 'web' ? (lang.startsWith('zh')?'网页预览':'Web preview') : panel === 'notes' ? t('notes.title') : panel === 'btw' ? t('session.btw.title') : agentTitle || t('session.chat.subagentPanelTitle') } : null;
  // Include a just-opened URL target immediately; persist after render.
  const tabs = (current && !tools.tabs.some(tab => tab.id === current.id) ? [...tools.tabs,current] : tools.tabs).filter(tab => (tab.id !== 'btw' || btwAllowed) && (tab.id !== 'board' || hasBoard));
  useEffect(() => {
    if (current) updateTools(state => openWorkspaceTab(state,current));
  }, [identity, activeTool, current?.title]);
  const selectTool = (id:string) => id.startsWith('panel:') ? openMachinePanel(id.slice(6)) : isHistoryPanel(id) ? onPanel(id) : id === 'board' ? onPanel('board') : id === 'web' ? onPanel('web') : id === 'notes' ? onPanel('notes') : id === 'btw' ? onPanel('btw') : onSubagent(id.slice(6));
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
      tabs={[...fileProps.tabs.filter(tab=>!tab.id.startsWith('tool:') || (!activeTool && tab.id===fileProps.active)),...tabs.filter(tab=>tab.id!=='notes').map(tab=>({...tab,id:`extra:${tab.id}`,group:'tools'})),...(tabs.some(tab=>tab.id==='notes')?notes.tabProps.tabs.map(tab=>({...tab,id:`notes:${tab.id}`,closable:true})):[])]}
      active={activeTool==='notes'?`notes:${notes.tabProps.active}`:activeTool ? `extra:${activeTool}` : fileProps.active}
      actions={<><ActionDropdownMenu items={[
        ...fileProps.tabs.filter(tab=>tab.id.startsWith('tool:')).map(tab=>({key:tab.id,label:tab.title,icon:tab.id==='tool:browse'?FolderOpen:tab.id==='tool:changed'?GitCompareArrows:Files,onSelect:()=>fileProps.onSelect(tab.id)})),
        ...(hasBoard?[{key:'board',label:boardTitle,icon:ClipboardList,onSelect:()=>onPanel('board')}]:[]),
        {key:'web',label:lang.startsWith('zh')?'网页预览':'Web preview',icon:Globe,onSelect:()=>onPanel('web')},
        ...webPanels.map(p=>({key:`panel:${p.id}`,label:p.title,icon:MonitorPlay,onSelect:()=>openMachinePanel(p.id)})),
        ...(btwAllowed?[{key:'btw',label:t('session.btw.title'),icon:MessageCircleQuestion,onSelect:()=>onPanel('btw')}]:[]),
        {key:'notes',label:t('notes.title'),icon:StickyNote,onSelect:()=>onPanel('notes')},
        {key:'previews',label:t('toolHistory.previewsTitle'),icon:FileSearch,onSelect:()=>onPanel('previews')},
        {key:'clipboard',label:t('toolHistory.clipboardTitle'),icon:Copy,onSelect:()=>onPanel('clipboard')},
      ]}><button className="fp-icon" aria-label={lang.startsWith('zh')?'打开工具':'Open tools'} title={lang.startsWith('zh')?'打开工具':'Open tools'}><Plus size={17}/></button></ActionDropdownMenu>{activeTool==='notes'&&notes.actions}{fileProps.actions}</>}
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
      {tab.id.startsWith('panel:')?<MachinePanelFrame panel={webPanels.find(p=>`panel:${p.id}`===tab.id) ?? null}/>:isHistoryPanel(tab.id)?<SessionHistoryPanel sessionId={sessionId} kind={tab.id}/>:tab.id==='board'?<BoardPanel sessionId={sessionId} onClose={onClose}/>:tab.id==='web'?<BrowserPreview identity={identity}/>:tab.id==='notes'?notes.content:tab.id==='btw'
        ? <BtwPanel sessionId={sessionId} embedded active={visible && activeTool===tab.id} onClose={()=>closeTool(tab.id)}/>
        : <SubagentPanel sessionId={sessionId} messageId={tab.id.slice(6)} embedded onClose={()=>closeTool(tab.id)}/>}
    </WorkspacePane>)}
  </FilesPanel>;
}
