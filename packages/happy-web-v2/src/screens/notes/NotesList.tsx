/**
 * NotesList — the all-notes list (dock list view + /notes screen left pane):
 * display title (explicit wins, B-119), tag chips, binding chip, compact mono
 * age, filter passthrough, archived view (B-118), and the per-row context
 * menu (right-click / touch long-press via Radix, B-120): pin, rename+tags,
 * archive/unarchive, delete.
 */
import { useState } from 'react';
import { Archive, ArchiveRestore, Link2, Pencil, Pin, StickyNote, Trash2 } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { Modal } from '@/modal';
import { ActionContextMenu, TagChip, type MenuItemDef } from '@/ui';
import { useNotes } from '@/sync/notesStore';
import { noteDisplayTitle, sortNotes, type NoteRecord } from '@/sync/notes';
import { RenameModal } from '@/screens/sessions/RenameModal';

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

export function NotesList({ filter, activeId, onOpen, onPin, pinLabel, archivedView }: {
    filter?: string;
    activeId?: string | null;
    onOpen: (id: string) => void;
    /** B-117: dock split view — pin this note as a tab (hover affordance). */
    onPin?: (id: string) => void;
    pinLabel?: string;
    /** B-118: true = show ONLY archived notes; default shows only live ones. */
    archivedView?: boolean;
}) {
    const { t } = useTranslation();
    const notesMap = useNotes((s) => s.notes);
    const loaded = useNotes((s) => s.loaded);
    const [renaming, setRenaming] = useState<NoteRecord | null>(null);
    const now = Date.now();

    const needle = (filter ?? '').trim().toLowerCase();
    const notes = sortNotes(Object.values(notesMap)).filter((n: NoteRecord) => {
        if ((n.archived === true) !== (archivedView === true)) return false;
        if (!needle) return true;
        return n.content.toLowerCase().includes(needle)
            || (n.title?.toLowerCase().includes(needle) ?? false)
            || (n.tags?.some((tag) => tag.toLowerCase().includes(needle)) ?? false)
            || (n.boundTo?.title.toLowerCase().includes(needle) ?? false);
    });

    const menuFor = (note: NoteRecord): MenuItemDef[] => [
        ...(onPin ? [{ key: 'pin', label: pinLabel ?? t('notes.pinTab'), icon: Pin, onSelect: () => onPin(note.id) }] : []),
        { key: 'rename', label: t('notes.renameTags'), icon: Pencil, onSelect: () => setRenaming(note) },
        note.archived
            ? { key: 'unarchive', label: t('notes.unarchive'), icon: ArchiveRestore, onSelect: () => useNotes.getState().updateMeta(note.id, { archived: false }) }
            : { key: 'archive', label: t('notes.archive'), icon: Archive, onSelect: () => useNotes.getState().updateMeta(note.id, { archived: true }) },
        {
            key: 'delete',
            label: t('common.delete'),
            icon: Trash2,
            danger: true,
            separatorBefore: true,
            onSelect: () => {
                void Modal.confirm(t('notes.deleteConfirm', { title: noteDisplayTitle(note) || t('notes.untitled') }), undefined, {
                    confirmText: t('common.delete'),
                    destructive: true,
                }).then((ok) => {
                    if (ok) useNotes.getState().deleteNote(note.id);
                });
            },
        },
    ];

    if (notes.length === 0) {
        return (
            <div className="notes-list-empty">
                <StickyNote size={20} />
                <span>{needle ? t('notes.noMatch') : loaded ? t('notes.empty') : t('notes.loading')}</span>
            </div>
        );
    }

    return (
        <>
        <ul className="notes-list" role="listbox">
            {notes.map((note) => {
                const title = noteDisplayTitle(note);
                return (
                    <li key={note.id} className="notes-list-item">
                        {onPin && (
                            <button
                                type="button"
                                className="notes-list-pin"
                                onClick={() => onPin(note.id)}
                                aria-label={pinLabel}
                                title={pinLabel}
                            >
                                <Pin size={11} />
                            </button>
                        )}
                        <ActionContextMenu items={menuFor(note)}>
                            <button
                                type="button"
                                className={`notes-list-row${note.id === activeId ? ' is-active' : ''}`}
                                onClick={() => onOpen(note.id)}
                            >
                                <span className={`notes-list-title${title ? '' : ' is-untitled'}`}>
                                    {title || t('notes.untitled')}
                                </span>
                                <span className="notes-list-sub">
                                    {note.tags?.map((tag) => <TagChip key={tag} tag={tag} />)}
                                    {note.boundTo && (
                                        <span className="notes-list-bind">
                                            <Link2 size={10} />
                                            {note.boundTo.title}
                                        </span>
                                    )}
                                    <span className="notes-list-age">{ago(note.updatedAt, now)}</span>
                                </span>
                            </button>
                        </ActionContextMenu>
                    </li>
                );
            })}
        </ul>
        {renaming && (
            <RenameModal
                defaultTitle={renaming.title ?? ''}
                tags={renaming.tags ?? []}
                onClose={() => setRenaming(null)}
                onSave={(title, tags) => {
                    useNotes.getState().updateMeta(renaming.id, { title, tags: tags ?? [] });
                    setRenaming(null);
                }}
            />
        )}
        </>
    );
}
