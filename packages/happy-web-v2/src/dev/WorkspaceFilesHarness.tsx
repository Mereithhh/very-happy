import './workspaceFilesPreview.css';
import { useEffect, useState } from 'react';
import { SessionWorkspacePanel } from '@/screens/session/SessionWorkspacePanel';
import type { SessionPanelTab } from '@/screens/session/sessionPanelState';
import { NotesDock } from '@/screens/notes/NotesDock';
import { useNotes } from '@/sync/notesStore';
import { storage } from '@/sync/storage';
import { LiveStatusRow } from '@/screens/session/SessionLiveStatusBar';
import { btwStore } from '@/sync/btwStore';
import { createReducer } from '@/sync/reducer/reducer';
import type { ToolCallMessage } from '@/sync/typesMessage';
import type { Session } from '@/sync/storageTypes';

/** DEV-only workspace with local file and conversation fixtures. */
export function WorkspaceFilesHarness() {
  const [showActivity, setShowActivity] = useState(false);
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState('workspace-fixture-a');
  const [open, setOpen] = useState(true);
  const [panel,setPanel] = useState<SessionPanelTab>('browse');
  const [target,setTarget] = useState('example-agent');
  useEffect(() => {
    const originalAsk = btwStore.getState().ask;
    btwStore.setState({ask: async (id, question) => {
      if (!id.startsWith('workspace-fixture-')) return originalAsk(id, question);
      btwStore.setState(state => ({sessions:{...state.sessions,[id]:{draft:'',exchanges:[...(state.sessions[id]?.exchanges ?? []),{id:String(Date.now()),question,answer:'这是本地演示回答。你可以切换标签、继续输入或清空记录；不会向 Agent 发送请求。',status:'done',startedAt:Date.now(),hadContext:true}]}}}));
    }});
    const now = Date.now();
    for (const id of ['workspace-fixture-a', 'workspace-fixture-b']) {
      storage.getState().applySessions([{ id, seq: 0, createdAt: now, updatedAt: now, active: true, activeAt: now, metadata: { machineId:'workspace-preview-machine', path: '/example', host: 'example', flavor:'claude', capabilities:['claude-btw-v1'] }, metadataVersion: 1, agentState: null, agentStateVersion: 0, thinking: false, thinkingAt: 0, presence:'online' } as Session]);
      const agent: ToolCallMessage = {kind:'tool-call',id:'example-agent',localId:null,createdAt:now,tool:{name:'Agent',state:'completed',input:{description:'布局检查 · 示例',subagent_type:'Review',prompt:'检查右侧工作区的视觉层次、移动端与功能入口。'},createdAt:now,startedAt:now,completedAt:now,description:null,result:'## 检查结果（本地示例）\n\n统一了文件、笔记、旁问的画布与工具栏。\n\n- 所有工具可由 + 菜单访问\n- 标签关闭和切换保持原有行为\n- 等待设计确认'},children:[]};
      storage.setState(state=>({sessionMessages:{...state.sessionMessages,[id]:{messages:[agent],messagesMap:{[agent.id]:agent},reducerState:createReducer(),isLoaded:true,hasMoreOlder:false,isLoadingOlder:false}}}));
      const pathKey = storage.getState().getSessionPathKey(id)!;
      storage.getState().applyProjectFiles(pathKey, { fetchedAt: now, files: ['src/index.ts','test/index.ts'].map(fullPath => ({ fullPath, fileName:'index.ts', filePath:fullPath.split('/')[0] })) });
      for (const path of ['src/index.ts','test/index.ts']) storage.getState().applyFileCache(id, path, Array.from({length:100},(_,i)=>`// ${id} ${path} line ${i + 1}`).join('\n'), null, false);
    }
    useNotes.setState({loaded:true,notes:{
      'example-note-a':{id:'example-note-a',title:'工作区验收清单',content:'本地设计草稿\n\n□ 文件目录和内容自然衔接\n□ 标签切换保留内容\n□ 手机输入 16px\n□ 设计确认后再发布',createdAt:now,updatedAt:now},
      'example-note-b':{id:'example-note-b',title:'更新说明草稿',content:'统一整个右侧工作区的视觉层次。',createdAt:now,updatedAt:now},
    }});
    storage.getState().applyLocalSettings({notesOpenTabs:['example-note-a','example-note-b'],notesActiveTab:'example-note-a'});
    setReady(true);
    return () => btwStore.setState({ask:originalAsk});
  }, []);
  return <div style={{height:'100dvh',display:'flex',flexDirection:'column'}}>
    <div style={{display:'flex',gap:8,padding:8,flexWrap:'wrap'}}><span>本地预览 · 示例数据</span><button onClick={()=>document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark'}>切换明暗</button><button onClick={()=>setSession(session.endsWith('-a')?'workspace-fixture-b':'workspace-fixture-a')}>切换示例</button><button onClick={()=>setOpen(true)}>打开面板</button><button onClick={()=>setShowActivity(v=>!v)}>Loading 效果</button><button onClick={()=>setPanel('browse')}>文件</button><button onClick={()=>setPanel('web')}>网页</button><button onClick={()=>setPanel('btw')}>旁问</button><button onClick={()=>setPanel('subagent')}>子代理</button><button onClick={()=>setPanel('notes')}>笔记</button></div>
    {showActivity && <div style={{padding:'16px',borderBottom:'1px solid var(--line)'}}><LiveStatusRow phase="requesting" label="请求中 · 本地示例" elapsed={149} metrics={[{kind:'input',value:'32'},{kind:'output',value:'20'}]} /></div>}
    <div className="workspace-preview-layout"><main className="workspace-preview-chat"><header>工作区视觉预览 <span>本地示例</span></header><section><p className="workspace-preview-question">帮我检查这次更新的文件，顺便看看有没有遗漏。</p><p>我会检查文件改动与验证结果。你也可以在右侧随时旁问，主任务继续运行。</p><p className="workspace-preview-tool">⌄　<span>●</span>　Read <small>src/workspace.tsx</small></p></section><div className="workspace-preview-input">输入消息…<div>＋ <small>自动执行</small><span>↑</span></div></div></main><div className="workspace-preview-aside">{ready && open && <SessionWorkspacePanel key={session} refreshOnMount={false} sessionId={session} panel={panel} subagentTarget={target} btwAllowed onPanel={setPanel} onSubagent={id=>{setTarget(id);setPanel('subagent');}} onClose={()=>setOpen(false)}/>}</div></div>
  </div>;
}


export function WorkspaceNotesHarness() {
  const [ready,setReady] = useState(false);
  useEffect(()=>{
    const now=Date.now();
    useNotes.setState({loaded:true,notes:{
      'example-note-a':{id:'example-note-a',title:'工作区验收清单',content:'本地设计草稿\n\n□ 文件目录和内容自然衔接\n□ 标签切换保留内容\n□ 手机输入 16px\n□ 设计确认后再发布',createdAt:now,updatedAt:now},
      'example-note-b':{id:'example-note-b',title:'更新说明草稿',content:'统一整个右侧工作区的视觉层次。',createdAt:now,updatedAt:now},
    }});
    storage.getState().applyLocalSettings({notesPanelOpen:true,notesOpenTabs:['example-note-a','example-note-b'],notesActiveTab:'example-note-a'});
    setReady(true);
  },[]);
  return <div style={{height:'100dvh',display:'flex'}}><main style={{flex:1,padding:16}}>Example · real notes dock</main>{ready&&<NotesDock/>}</div>;
}
