/**
 * NoteEditor — the shared editing surface (dock tab + /notes screen): binding
 * chip row, mono textarea with autosave (store debounces the KV push), and the
 * insert-to-input action (chat composer / terminal bracketed paste — the
 * receiving end guarantees "never auto-executes").
 */
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { CornerDownLeft, Link2, Link2Off, Trash2 } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { Modal } from '@/modal';
import { toast } from '@/ui/Toast';
import { requestInsertToInput } from '@/app/insertToInput';
import { useNotes } from '@/sync/notesStore';
import { NOTE_CONTENT_MAX_CHARS, deriveNoteTitle } from '@/sync/notes';
import { bindingHref, useCurrentBindTarget } from './useCurrentBindTarget';
import { closeNoteTab } from './notesPanelState';

export function NoteEditor({ noteId, autoFocus, onDeleted }: {
    noteId: string;
    autoFocus?: boolean;
    /** extra cleanup for the host view (the dock also closes the tab itself) */
    onDeleted?: () => void;
}) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const note = useNotes((s) => s.notes[noteId]);
    const bindTarget = useCurrentBindTarget();

    const insert = useCallback(() => {
        if (!note || note.content.trim().length === 0) return;
        if (!requestInsertToInput(note.content)) {
            toast.error(t('notes.noInputHere'));
        }
    }, [note, t]);

    const remove = useCallback(async () => {
        if (!note) return;
        const title = deriveNoteTitle(note.content) || t('notes.untitled');
        const ok = await Modal.confirm(
            t('notes.deleteTitle'),
            t('notes.deleteConfirm', { title }),
            { confirmText: t('notes.deleteTitle'), destructive: true },
        );
        if (!ok) return;
        useNotes.getState().deleteNote(noteId);
        closeNoteTab(noteId);
        onDeleted?.();
    }, [note, noteId, onDeleted, t]);

    if (!note) {
        return <div className="notes-editor-missing">{t('notes.missing')}</div>;
    }

    return (
        <div className="notes-editor">
            <div className="notes-editor-meta">
                {note.boundTo ? (
                    <>
                        <button
                            type="button"
                            className="notes-bind-chip"
                            onClick={() => navigate(bindingHref(note.boundTo!))}
                            title={t('notes.jumpToBound')}
                        >
                            <Link2 size={12} />
                            <span className="notes-bind-title">{note.boundTo.title}</span>
                        </button>
                        <button
                            type="button"
                            className="notes-meta-btn"
                            onClick={() => useNotes.getState().updateBinding(noteId, null)}
                            aria-label={t('notes.unbind')}
                            title={t('notes.unbind')}
                        >
                            <Link2Off size={12} />
                        </button>
                    </>
                ) : bindTarget ? (
                    <button
                        type="button"
                        className="notes-bind-chip notes-bind-chip--offer"
                        onClick={() => useNotes.getState().updateBinding(noteId, bindTarget)}
                        title={t('notes.bindHere', { title: bindTarget.title })}
                    >
                        <Link2 size={12} />
                        <span className="notes-bind-title">{t('notes.bindHere', { title: bindTarget.title })}</span>
                    </button>
                ) : (
                    <span className="notes-bind-none">{t('notes.unbound')}</span>
                )}
                <span className="notes-editor-spacer" />
                <button
                    type="button"
                    className="notes-meta-btn notes-meta-btn--danger"
                    onClick={() => void remove()}
                    aria-label={t('notes.deleteTitle')}
                    title={t('notes.deleteTitle')}
                >
                    <Trash2 size={13} />
                </button>
            </div>
            <textarea
                className="notes-editor-ta"
                value={note.content}
                maxLength={NOTE_CONTENT_MAX_CHARS}
                onChange={(e) => useNotes.getState().updateContent(noteId, e.target.value)}
                placeholder={t('notes.placeholder')}
                autoFocus={autoFocus}
                spellCheck={false}
            />
            <div className="notes-editor-actions">
                <span className="notes-editor-count">{note.content.length.toLocaleString()}</span>
                <button
                    type="button"
                    className="notes-insert-btn"
                    onClick={insert}
                    disabled={note.content.trim().length === 0}
                >
                    <CornerDownLeft size={13} />
                    {t('notes.insert')}
                </button>
            </div>
        </div>
    );
}
