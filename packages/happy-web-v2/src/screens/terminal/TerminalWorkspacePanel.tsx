import { useEffect } from 'react';
import { Globe, StickyNote, X } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { FsBrowser } from '../files/FsBrowser';
import { useNotesWorkspace } from '../notes/useNotesWorkspace';
import { OrderedWorkspaceTabs } from '../workspace/OrderedWorkspaceTabs';
import { WorkspacePane } from '../workspace/WorkspacePane';
import { BrowserPreview } from '../workspace/BrowserPreview';
import { useWorkspaceView } from '../workspace/workspaceViewStore';
import { openWorkspaceTab,closeWorkspaceTab } from '../workspace/workspaceTabModel';
import '../session/files.css';
import '../session/session.css';
export type TerminalWorkspaceKind = 'files' | 'notes' | 'web';
export function TerminalWorkspacePanel({identity,machineId,path,active,visible=true,onSelect,onClose}:{identity:string;machineId:string;path:string;active:TerminalWorkspaceKind;visible?:boolean;onSelect:(kind:TerminalWorkspaceKind)=>void;onClose:()=>void}) {
 const {t,lang}=useTranslation();const zh=lang.startsWith('zh');
 const notes=useNotesWorkspace(visible&&active==='notes');const [views,setViews]=useWorkspaceView(`terminal-tools:${identity}`);
 useEffect(()=>{if(active!=='files')setViews(s=>openWorkspaceTab(s,{id:active,title:active}));},[identity,active]);
 const hasNotes=active==='notes'||views.tabs.some(tab=>tab.id==='notes');const hasWeb=active==='web'||views.tabs.some(tab=>tab.id==='web');
 const select=(id:string)=>{if(id.startsWith('notes:')){notes.tabProps.onSelect(id.slice(6));onSelect('notes');}else onSelect(id as TerminalWorkspaceKind);};
 const close=(id:string)=>{if(id==='files'){onClose();return;}if(id.startsWith('notes:')&&id!=='notes:list'){notes.tabProps.onClose(id.slice(6));return;}const kind=id==='notes:list'?'notes':'web';setViews(s=>closeWorkspaceTab(s,kind));if(active===kind)onSelect('files');};
 return <div className="fp">
  <OrderedWorkspaceTabs identity={`terminal:${identity}`} tabs={[{id:'files',title:t('session.chat.files'),group:'tools',closable:false},...(hasWeb?[{id:'web',title:zh?'网页预览':'Web preview',group:'tools'}]:[]),...(hasNotes?notes.tabProps.tabs.map(tab=>({...tab,id:`notes:${tab.id}`,closable:true})):[])]} active={visible&&active==='notes'?`notes:${notes.tabProps.active}`:active} onSelect={select} onClose={close}
   onCloseOthers={id=>{setViews(state=>({...state,tabs:state.tabs.filter(tab=>id.startsWith('notes:')?tab.id==='notes':tab.id===id),active:null}));if(hasNotes)notes.tabProps.tabs.filter(tab=>tab.closable!==false&&`notes:${tab.id}`!==id).forEach(tab=>notes.tabProps.onClose(tab.id));select(id);}}
   onMove={(id,target)=>{if(id.startsWith('notes:')&&target.startsWith('notes:'))notes.tabProps.onMove(id.slice(6),target.slice(6));}}
   actions={<>{active==='notes'&&notes.actions}<button className="fp-icon" onClick={()=>onSelect('notes')} aria-label={t('notes.title')}><StickyNote size={15}/></button><button className="fp-icon" onClick={()=>onSelect('web')} aria-label={zh?'网页预览':'Web preview'}><Globe size={15}/></button><button className="fp-icon" onClick={onClose} aria-label={t('session.chat.closeFiles')}><X size={15}/></button></>}/>
  <WorkspacePane order={identity} className="session-workspace-pane" active={visible&&active==='files'}><FsBrowser active={visible&&active==='files'} viewKey={`terminal:${identity}`} machineId={machineId} initialPath={path}/></WorkspacePane>
  {hasNotes&&<WorkspacePane order={identity} className="session-workspace-pane" active={visible&&active==='notes'}>{notes.content}</WorkspacePane>}
  {hasWeb&&<WorkspacePane order={identity} className="session-workspace-pane" active={visible&&active==='web'}><BrowserPreview identity={`terminal:${identity}`}/></WorkspacePane>}
 </div>;
}
