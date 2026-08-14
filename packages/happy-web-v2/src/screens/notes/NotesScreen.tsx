/**
 * NotesScreen — /notes: the global view (every note, filterable) plus a
 * full-width editor. Desktop = two panes; mobile = list, tap into the editor
 * (back returns to the list). The dock hides itself on this route.
 */
import { useEffect, useState } from 'react';
import { ArrowLeft, Plus } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { useAuth } from '@/auth/AuthContext';
import { useMediaQuery } from '@/app/useMediaQuery';
import { useNotes, setNotesCredentials } from '@/sync/notesStore';
import { toast } from '@/ui/Toast';
import { NoteEditor } from './NoteEditor';
import { NotesList } from './NotesList';
import './notes.css';

export function NotesScreen() {
    const { t } = useTranslation();
    const { credentials } = useAuth();
    const wide = useMediaQuery('(min-width: 861px)');
    const notesMap = useNotes((s) => s.notes);
    const [selected, setSelected] = useState<string | null>(null);
    const [filter, setFilter] = useState('');

    useEffect(() => {
        setNotesCredentials(credentials);
        if (credentials) void useNotes.getState().initialize();
    }, [credentials]);

    const selectedNote = selected ? notesMap[selected] : undefined;

    const createNote = () => {
        const id = useNotes.getState().createNote();
        if (id === null) {
            toast.error(t('notes.capReached'));
            return;
        }
        setSelected(id);
    };

    const listPane = (
        <div className="notes-screen-list">
            <div className="notes-screen-toolbar">
                <input
                    className="notes-screen-filter"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder={t('notes.filterPlaceholder')}
                    spellCheck={false}
                />
                <button type="button" className="notes-screen-new" onClick={createNote} aria-label={t('notes.new')} title={t('notes.new')}>
                    <Plus size={15} />
                </button>
            </div>
            <div className="notes-screen-listbody">
                <NotesList filter={filter} activeId={selected} onOpen={setSelected} />
            </div>
        </div>
    );

    const editorPane = selectedNote ? (
        <div className="notes-screen-editor">
            {!wide && (
                <button type="button" className="notes-screen-back" onClick={() => setSelected(null)}>
                    <ArrowLeft size={14} />
                    {t('notes.allNotes')}
                </button>
            )}
            <NoteEditor noteId={selectedNote.id} autoFocus onDeleted={() => setSelected(null)} />
        </div>
    ) : (
        <div className="notes-screen-editor notes-screen-editor--empty">{t('notes.pickOrCreate')}</div>
    );

    return (
        <div className="notes-screen">
            {wide ? (
                <>
                    {listPane}
                    {editorPane}
                </>
            ) : selectedNote ? (
                editorPane
            ) : (
                listPane
            )}
        </div>
    );
}
