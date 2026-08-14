/**
 * NotesDock — the right-side notes panel (B-094), mounted ONCE in AppLayout's
 * main row so it squeezes whatever screen is active (chat / terminal / board)
 * instead of floating over it. ≤860px or coarse pointers get a full-screen
 * overlay (CSS), desktop gets the drag handle (right-anchored, width in
 * localSettings like filesPanelWidth).
 *
 * Also owns the ⌘J/Ctrl+J toggle and the store bootstrap (credentials come
 * from CONTEXT — getCurrentAuth() is published from AuthProvider's effect and
 * child effects run first; see setNotesCredentials).
 */
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { List, Maximize2, Plus, X } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { useAuth } from '@/auth/AuthContext';
import { useMediaQuery } from '@/app/useMediaQuery';
import { useLocalSetting } from '@/sync/storage';
import { useNotes, setNotesCredentials } from '@/sync/notesStore';
import { deriveNoteTitle, pruneNoteTabs } from '@/sync/notes';
import { isImeGuardedEvent } from '@/utils/ime';
import { toast } from '@/ui/Toast';
import { useNotesPanelWidth } from './useNotesPanelWidth';
import { useCurrentBindTarget } from './useCurrentBindTarget';
import { NoteEditor } from './NoteEditor';
import { NotesList } from './NotesList';
import { closeNoteTab, openNoteTab, setNotesPanelOpen, showNotesList, toggleNotesPanel } from './notesPanelState';
import './notes.css';

export function NotesDock() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const location = useLocation();
    const { credentials } = useAuth();
    const open = useLocalSetting('notesPanelOpen');
    const tabs = useLocalSetting('notesOpenTabs');
    const activeTab = useLocalSetting('notesActiveTab');
    const notesMap = useNotes((s) => s.notes);
    const loaded = useNotes((s) => s.loaded);
    // Breakpoints follow useIsDesktop (980px): below it AppLayout renders the
    // single-pane mobile shell, where the dock must be the fixed overlay.
    const resizable = useMediaQuery('(min-width: 980px) and (pointer: fine)');
    const wide = useMediaQuery('(min-width: 980px)');
    const { width, onHandleMouseDown } = useNotesPanelWidth();
    const bindTarget = useCurrentBindTarget();
    const bindTargetRef = useRef(bindTarget);
    bindTargetRef.current = bindTarget;
    const onNotesRoute = location.pathname.startsWith('/notes');
    const onNotesRouteRef = useRef(onNotesRoute);
    onNotesRouteRef.current = onNotesRoute;

    // ⌘J / Ctrl+J toggle — capture phase (ahead of xterm's helper textarea),
    // IME-guarded, physical key via e.code (same conventions as ⌘N/⌘W).
    // No-op on /notes: the dock is hidden there and toggling invisible state
    // would surprise the next route.
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (isImeGuardedEvent(e)) return;
            if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.code !== 'KeyJ') return;
            e.preventDefault();
            e.stopPropagation();
            if (!onNotesRouteRef.current) toggleNotesPanel();
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, []);

    // Store bootstrap: lazy — first open (or a restored open panel) loads KV.
    const initializedRef = useRef(false);
    useEffect(() => {
        setNotesCredentials(credentials);
        if (!credentials || !open || initializedRef.current) return;
        initializedRef.current = true;
        void useNotes.getState().initialize();
    }, [credentials, open]);

    // Notes deleted on another device must not linger as dead tabs.
    useEffect(() => {
        if (!loaded) return;
        const ids = new Set(Object.keys(notesMap));
        const pruned = pruneNoteTabs(tabs, ids);
        if (pruned.length !== tabs.length) {
            for (const id of tabs) if (!ids.has(id)) closeNoteTab(id);
        }
    }, [loaded, notesMap, tabs]);

    if (!open || onNotesRoute) return null;

    const createNote = () => {
        const id = useNotes.getState().createNote({ boundTo: bindTargetRef.current });
        if (id === null) {
            toast.error(t('notes.capReached'));
            return;
        }
        openNoteTab(id);
    };

    const activeNote = activeTab ? notesMap[activeTab] : undefined;

    return (
        <>
            <div className="notes-dock-scrim" onClick={() => setNotesPanelOpen(false)} aria-hidden />
            {resizable && (
                <div
                    className="app-resize-handle notes-dock-handle"
                    onMouseDown={onHandleMouseDown}
                    role="separator"
                    aria-orientation="vertical"
                />
            )}
            <aside className="notes-dock" style={wide ? { width } : undefined} aria-label={t('notes.title')}>
                <div className="notes-dock-tabs">
                    <button
                        type="button"
                        className={`notes-tab notes-tab--list${activeTab === null ? ' is-active' : ''}`}
                        onClick={showNotesList}
                        aria-label={t('notes.allNotes')}
                        title={t('notes.allNotes')}
                    >
                        <List size={14} />
                    </button>
                    <div className="notes-dock-tabstrip">
                        {tabs.map((id) => {
                            const note = notesMap[id];
                            const title = note ? deriveNoteTitle(note.content) || t('notes.untitled') : t('notes.untitled');
                            return (
                                <div key={id} className={`notes-tab${id === activeTab ? ' is-active' : ''}`}>
                                    <button type="button" className="notes-tab-label" onClick={() => openNoteTab(id)} title={title}>
                                        {title}
                                    </button>
                                    <button
                                        type="button"
                                        className="notes-tab-close"
                                        onClick={() => closeNoteTab(id)}
                                        aria-label={t('notes.closeTab')}
                                    >
                                        <X size={11} />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                    <button type="button" className="notes-tab notes-tab--icon" onClick={createNote} aria-label={t('notes.new')} title={t('notes.new')}>
                        <Plus size={14} />
                    </button>
                    <button
                        type="button"
                        className="notes-tab notes-tab--icon"
                        onClick={() => navigate('/notes')}
                        aria-label={t('notes.fullscreen')}
                        title={t('notes.fullscreen')}
                    >
                        <Maximize2 size={13} />
                    </button>
                    <button
                        type="button"
                        className="notes-tab notes-tab--icon"
                        onClick={() => setNotesPanelOpen(false)}
                        aria-label={t('notes.close')}
                        title={t('notes.close')}
                    >
                        <X size={14} />
                    </button>
                </div>
                <div className="notes-dock-body">
                    {activeNote ? (
                        <NoteEditor noteId={activeNote.id} autoFocus />
                    ) : (
                        <NotesList activeId={activeTab} onOpen={openNoteTab} />
                    )}
                </div>
            </aside>
        </>
    );
}
