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
import { isAppChord } from '@/app/appChord';
import { useLocation } from 'react-router-dom';
import { X } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { useAuth } from '@/auth/AuthContext';
import { useMediaQuery } from '@/app/useMediaQuery';
import { useLocalSetting } from '@/sync/storage';
import { useNotes, setNotesCredentials } from '@/sync/notesStore';
import { pruneNoteTabs } from '@/sync/notes';
import { isImeGuardedEvent } from '@/utils/ime';
import { useNotesPanelWidth } from './useNotesPanelWidth';
import { closeNoteTab, setNotesPanelOpen, toggleNotesPanel } from './notesPanelState';
import { WorkspaceTabs } from '../workspace/WorkspaceTabs';
import { useNotesWorkspace } from './useNotesWorkspace';
import './notes.css';

export function NotesDock() {
    const location = useLocation();
    const { credentials } = useAuth();
    const open = useLocalSetting('notesPanelOpen');
    const tabs = useLocalSetting('notesOpenTabs');
    const notesMap = useNotes((s) => s.notes);
    const loaded = useNotes((s) => s.loaded);
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
            // isAppChord：macOS 上 Ctrl+J 是终端 readline 的 accept-line，不能被吞。
            if (!isAppChord(e) || e.shiftKey || e.altKey || e.code !== 'KeyJ') return;
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

    if (!open || onNotesRoute || /^\/(session|terminal)\/[^/]+/.test(location.pathname)) return null;

    return <NotesDockView/>;
}

function NotesDockView() {
    const {t} = useTranslation();
    const {tabProps,actions,content} = useNotesWorkspace();
    const resizable = useMediaQuery('(min-width: 1100px) and (pointer: fine)');
    const wide = useMediaQuery('(min-width: 1100px)');
    const {width,onHandleMouseDown} = useNotesPanelWidth();
    return <>
      <div className="notes-dock-scrim" onClick={()=>setNotesPanelOpen(false)} aria-hidden/>
      {resizable && <div className="app-resize-handle notes-dock-handle" onMouseDown={onHandleMouseDown} role="separator" aria-orientation="vertical"/>}
      <aside className="notes-dock" style={wide?{width}:undefined} aria-label={t('notes.title')}>
        <WorkspaceTabs {...tabProps} actions={<>{actions}<button type="button" className="notes-tab--icon" onClick={()=>setNotesPanelOpen(false)} aria-label={t('notes.close')} title={t('notes.close')}><X size={14}/></button></>}/>
        {content}
      </aside>
    </>;
}
