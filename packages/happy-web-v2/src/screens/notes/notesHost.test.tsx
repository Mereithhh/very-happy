// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
const toggle = vi.hoisted(()=>vi.fn());
vi.mock('@/app/appChord',()=>({isAppChord:()=>true}));
vi.mock('@/auth/AuthContext',()=>({useAuth:()=>({credentials:null})}));
vi.mock('@/sync/storage',()=>({useLocalSetting:(key:string)=>key==='notesPanelOpen'?true:[]}));
vi.mock('@/sync/notesStore',()=>({useNotes:(selector:(s:unknown)=>unknown)=>selector({notes:{},loaded:true}),setNotesCredentials:vi.fn()}));
vi.mock('./notesPanelState',()=>({closeNoteTab:vi.fn(),setNotesPanelOpen:vi.fn(),toggleNotesPanel:toggle}));
vi.mock('@/i18n/useTranslation',()=>({useTranslation:()=>({t:(key:string)=>key,lang:'en'})}));
vi.mock('./useNotesWorkspace',()=>({useNotesWorkspace:()=>({tabProps:{tabs:[],active:null,onSelect:vi.fn(),onClose:vi.fn(),onMove:vi.fn()},actions:null,content:'notes body'})}));
vi.mock('./useNotesPanelWidth',()=>({useNotesPanelWidth:()=>({width:380,onHandleMouseDown:vi.fn()})}));
vi.mock('@/app/useMediaQuery',()=>({DESKTOP_SHELL_MQ:'',useMediaQuery:()=>false}));
vi.mock('../workspace/WorkspaceTabs',()=>({WorkspaceTabs:()=>null}));
import { NotesDock } from './NotesDock';
it.each(['/session/example','/terminal/machine?tid=test'])('workspace routes suppress the second dock but retain the global shortcut runtime',async(path)=>{
 toggle.mockClear();
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 const host=document.createElement('div'); document.body.append(host); const root=createRoot(host);
 try {
  await act(async()=>root.render(<MemoryRouter initialEntries={[path]}><NotesDock/></MemoryRouter>));
  expect(host.querySelector('.notes-dock')).toBeNull();
  await act(async()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'j',code:'KeyJ',metaKey:true,bubbles:true})));
  expect(toggle).toHaveBeenCalledTimes(1);
 } finally {await act(async()=>root.unmount());host.remove();}
});
