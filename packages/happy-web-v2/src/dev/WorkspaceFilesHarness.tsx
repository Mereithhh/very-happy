import { useEffect, useState } from 'react';
import { SessionWorkspacePanel } from '@/screens/session/SessionWorkspacePanel';
import type { SessionPanelTab } from '@/screens/session/sessionPanelState';
import { NotesDock } from '@/screens/notes/NotesDock';
import { useNotes } from '@/sync/notesStore';
import { storage } from '@/sync/storage';
import type { Session } from '@/sync/storageTypes';

/** DEV-only real file panel with clearly labelled in-memory data. */
export function WorkspaceFilesHarness() {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState('workspace-fixture-a');
  const [open, setOpen] = useState(true);
  const [panel,setPanel] = useState<SessionPanelTab>('all');
  const [target,setTarget] = useState('example-agent');
  useEffect(() => {
    const now = Date.now();
    for (const id of ['workspace-fixture-a', 'workspace-fixture-b']) {
      storage.getState().applySessions([{ id, seq: 0, createdAt: now, updatedAt: now, active: true, activeAt: now, metadata: { path: `/example/${id}`, host: 'example', flavor:'claude', capabilities:['claude-btw-v1'], machineId: 'workspace-fixture-machine' }, metadataVersion: 1, agentState: null, agentStateVersion: 0, thinking: false, thinkingAt: 0, presence:'online' } as Session]);
      const pathKey = storage.getState().getSessionPathKey(id)!;
      storage.getState().applyProjectFiles(pathKey, { fetchedAt: now, files: ['src/index.ts','test/index.ts'].map(fullPath => ({ fullPath, fileName:'index.ts', filePath:fullPath.split('/')[0] })) });
      for (const path of ['src/index.ts','test/index.ts']) storage.getState().applyFileCache(id, path, Array.from({length:100},(_,i)=>`// ${id} ${path} line ${i + 1}`).join('\n'), null, false);
    }
    useNotes.setState({loaded:true,notes:{
      'example-note-a':{id:'example-note-a',title:'Review checklist',content:'Example note A',createdAt:now,updatedAt:now},
      'example-note-b':{id:'example-note-b',title:'Release notes',content:'Example note B',createdAt:now,updatedAt:now},
    }});
    storage.getState().applyLocalSettings({notesOpenTabs:['example-note-a','example-note-b'],notesActiveTab:'example-note-a'});
    setReady(true);
  }, []);
  return <div style={{height:'100dvh',display:'flex',flexDirection:'column'}}>
    <div style={{display:'flex',gap:8,padding:8,flexWrap:'wrap'}}><span>Example · real file panel</span><button onClick={()=>setSession(session.endsWith('-a')?'workspace-fixture-b':'workspace-fixture-a')}>Switch session</button><button onClick={()=>setOpen(true)}>Open panel</button><button onClick={()=>setPanel('btw')}>Side question</button><button onClick={()=>setPanel('subagent')}>Subagent</button><button onClick={()=>setPanel('notes')}>Notes</button></div>
    <div style={{flex:1,minHeight:0}}>{ready && open && <SessionWorkspacePanel key={session} refreshOnMount={false} sessionId={session} panel={panel} subagentTarget={target} btwAllowed onPanel={setPanel} onSubagent={id=>{setTarget(id);setPanel('subagent');}} onClose={()=>setOpen(false)}/>}</div>
  </div>;
}


export function WorkspaceNotesHarness() {
  const [ready,setReady] = useState(false);
  useEffect(()=>{
    const now=Date.now();
    useNotes.setState({loaded:true,notes:{
      'example-note-a':{id:'example-note-a',title:'Review checklist',content:'Example note A',createdAt:now,updatedAt:now},
      'example-note-b':{id:'example-note-b',title:'Release notes',content:'Example note B',createdAt:now,updatedAt:now},
    }});
    storage.getState().applyLocalSettings({notesPanelOpen:true,notesOpenTabs:['example-note-a','example-note-b'],notesActiveTab:'example-note-a'});
    setReady(true);
  },[]);
  return <div style={{height:'100dvh',display:'flex'}}><main style={{flex:1,padding:16}}>Example · real notes dock</main>{ready&&<NotesDock/>}</div>;
}
