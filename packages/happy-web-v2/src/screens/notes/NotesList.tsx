/**
 * NotesList — the all-notes list (dock list view + /notes screen left pane):
 * derived title, binding chip, compact mono age, filter passthrough.
 */
import { Link2, StickyNote } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { useNotes } from '@/sync/notesStore';
import { deriveNoteTitle, sortNotes, type NoteRecord } from '@/sync/notes';

/** compact mono age — machine-layer identity, deliberately not localized */
function ago(at: number, now: number): string {
    const s = Math.max(0, Math.floor((now - at) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
}

export function NotesList({ filter, activeId, onOpen }: {
    filter?: string;
    activeId?: string | null;
    onOpen: (id: string) => void;
}) {
    const { t } = useTranslation();
    const notesMap = useNotes((s) => s.notes);
    const loaded = useNotes((s) => s.loaded);
    const now = Date.now();

    const needle = (filter ?? '').trim().toLowerCase();
    const notes = sortNotes(Object.values(notesMap)).filter((n: NoteRecord) => {
        if (!needle) return true;
        return n.content.toLowerCase().includes(needle) || (n.boundTo?.title.toLowerCase().includes(needle) ?? false);
    });

    if (notes.length === 0) {
        return (
            <div className="notes-list-empty">
                <StickyNote size={20} />
                <span>{needle ? t('notes.noMatch') : loaded ? t('notes.empty') : t('notes.loading')}</span>
            </div>
        );
    }

    return (
        <ul className="notes-list" role="listbox">
            {notes.map((note) => {
                const title = deriveNoteTitle(note.content);
                return (
                    <li key={note.id}>
                        <button
                            type="button"
                            className={`notes-list-row${note.id === activeId ? ' is-active' : ''}`}
                            onClick={() => onOpen(note.id)}
                        >
                            <span className={`notes-list-title${title ? '' : ' is-untitled'}`}>
                                {title || t('notes.untitled')}
                            </span>
                            <span className="notes-list-sub">
                                {note.boundTo && (
                                    <span className="notes-list-bind">
                                        <Link2 size={10} />
                                        {note.boundTo.title}
                                    </span>
                                )}
                                <span className="notes-list-age">{ago(note.updatedAt, now)}</span>
                            </span>
                        </button>
                    </li>
                );
            })}
        </ul>
    );
}
