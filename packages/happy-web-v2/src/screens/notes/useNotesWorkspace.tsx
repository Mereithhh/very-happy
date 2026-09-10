import { useNavigate } from 'react-router-dom';
import { Maximize2, SquarePen } from 'lucide-react';
import { useLocalSetting } from '@/sync/storage';
import { useNotes } from '@/sync/notesStore';
import { noteDisplayTitle } from '@/sync/notes';
import { useTranslation } from '@/i18n/useTranslation';
import { toast } from '@/ui/Toast';
import { useCurrentBindTarget } from './useCurrentBindTarget';
import { closeNoteTab, openNoteTab, setNotesSplitNote, showNotesList, moveNoteTab } from './notesPanelState';
import { NoteEditor } from './NoteEditor';
import { NotesList } from './NotesList';
import type { ComponentProps } from 'react';
import type { WorkspaceTabs } from '../workspace/WorkspaceTabs';
import './notes.css';

/** Shared view only. NotesDock remains the sole auth/keyboard runtime owner. */
export function useNotesWorkspace(active = true) {
  const {t} = useTranslation();
  const navigate = useNavigate();
  const tabs = useLocalSetting('notesOpenTabs');
  const activeTab = useLocalSetting('notesActiveTab');
  const splitNote = useLocalSetting('notesSplitNote');
  const notes = useNotes(s=>s.notes);
  const binding = useCurrentBindTarget();
  const createNote = () => {
    const id = useNotes.getState().createNote({boundTo:binding});
    if(id === null) { toast.error(t('notes.capReached')); return; }
    showNotesList(); setNotesSplitNote(id);
  };
  const activeNote = activeTab ? notes[activeTab] : undefined;
  const split = splitNote ? notes[splitNote] : undefined;
  const tabProps: ComponentProps<typeof WorkspaceTabs> = {
    tabs:[{id:'list',title:t('notes.allNotes'),closable:false,movable:false},...tabs.map(id=>({id:`note:${id}`,title:notes[id]?noteDisplayTitle(notes[id])||t('notes.untitled'):t('notes.untitled'),group:'notes'}))],
    active:activeNote?`note:${activeTab}`:'list',
    onSelect:id=>id==='list'?showNotesList():openNoteTab(id.slice(5)),
    onClose:id=>closeNoteTab(id.slice(5)),
    onMove:(id,target)=>moveNoteTab(id.slice(5),target.slice(5)),
  };
  const actions = <>
    <button type="button" className="notes-tab--icon" onClick={createNote} aria-label={t('notes.new')} title={t('notes.new')}><SquarePen size={15}/></button>
    <button type="button" className="notes-tab--icon" onClick={()=>navigate('/notes')} aria-label={t('notes.fullscreen')} title={t('notes.fullscreen')}><Maximize2 size={13}/></button>
  </>;
  const content = <div className="notes-dock-body">
    {activeNote ? <NoteEditor key={activeNote.id} noteId={activeNote.id} autoFocus={active}/> : <div className="notes-split">
      <div className="notes-split-list"><NotesList activeId={splitNote} onOpen={id=>setNotesSplitNote(id===splitNote?null:id)} onPin={openNoteTab} pinLabel={t('notes.pinTab')}/></div>
      {split && <div className="notes-split-editor"><NoteEditor key={split.id} noteId={split.id} onDeleted={()=>setNotesSplitNote(null)}/></div>}
    </div>}
  </div>;
  return {tabProps, actions, content};
}
