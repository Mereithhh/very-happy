/**
 * Main agent (B-916a, B-923) shell pieces:
 *  - MainAgentHost: mounted once in AppLayout. Keeps the KV pointer fresh,
 *    turns an open request into the docked column (wide desktop) or the
 *    full-screen /main-agent page (narrow windows, phones), owns ⌘⇧E.
 *  - MainAgentDockSlot: the column's place at the right end of the shell's
 *    main row (AppShell `aside`). Measures the row to decide whether the
 *    column fits (mainAgentDock.ts rules) and renders it lazily.
 *  - MainAgentPage: the /main-agent route (MainAgentViews).
 *  - MainAgentEntry: the always-visible sidebar row above 新建会话.
 */

import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Bot } from 'lucide-react';
import { StatusDot } from '@/ui';
import { useIsDesktop, useMediaQuery } from '@/app/useMediaQuery';
import { useTranslation } from '@/i18n/useTranslation';
import { mainAgentCopy } from '@/assistant/mainAgentCopy';
import { mainAgentDockShowing, toggleMainAgent, useMainAgentStore } from '@/assistant/mainAgentStore';
import { useMainAgentPointerSync, useMainAgentState } from '@/assistant/useMainAgent';
import { mainAgentDot, mainAgentStatusDot } from '@/assistant/mainAgent';
import { isMainAgentChord, MAIN_AGENT_CHORD_HINT } from '@/screens/command/mainAgentPalette';
import { canDock, DETAIL_RESERVE, DOCK_HANDLE, DOCK_MIN, dockLayout, dockMaxWidth, NOTES_HANDLE, NOTES_MIN } from './mainAgentDock';
import { useLocalSetting } from '@/sync/storage';
import { resolveNotesPanelWidth } from '@/screens/notes/notesPanelWidth';
import './mainAgent.css';

const MainAgentDock = lazy(() => import('./MainAgentViews').then((m) => ({ default: m.MainAgentDock })));

export const MAIN_AGENT_PATH = '/main-agent';

/** The page under the shell's root (`/` in the app; the DEV device harness mounts it elsewhere). */
export function mainAgentPath(rootPath = '/'): string {
    return `${rootPath.replace(/\/$/, '')}${MAIN_AGENT_PATH}`;
}

export function MainAgentHost({ rootPath = '/' }: { rootPath?: string } = {}) {
    useMainAgentPointerSync();
    const navigate = useNavigate();
    const location = useLocation();
    const openRequest = useMainAgentStore((s) => s.openRequest);
    const pagePath = mainAgentPath(rootPath);
    const onPage = location.pathname === pagePath;
    const handled = useRef(openRequest);

    // an open request: dock the column when this window can, else the full-screen page
    useEffect(() => {
        if (openRequest === handled.current) return;
        handled.current = openRequest;
        const st = useMainAgentStore.getState();
        if (st.dockAvailable && !onPage) st.setDockOpen(true);
        else if (!onPage) navigate(pagePath);
    }, [openRequest, onPage, navigate, pagePath]);

    // ⌘⇧E toggles the main agent anywhere (⌘J is notes; ⌘⇧A is the browser's tab search)
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.defaultPrevented) return;
            if (!isMainAgentChord(e)) return;
            e.preventDefault();
            toggleMainAgent();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);
    return null;
}

/**
 * Rendered inside `.app-main-row` (display: contents, so it adds no box). It
 * watches the row's width — the space right of the sidebar — and publishes
 * whether the column fits; widths for the column and the notes dock sharing
 * the row come from dockLayout (mainAgentDock.ts).
 */
export function MainAgentDockSlot({ rootPath = '/' }: { rootPath?: string } = {}) {
    const isDesktop = useIsDesktop();
    const location = useLocation();
    const onPage = location.pathname === mainAgentPath(rootPath);
    const ref = useRef<HTMLDivElement | null>(null);
    const [rowWidth, setRowWidth] = useState(0);
    const open = useMainAgentStore((s) => s.dockOpen);
    const stored = useMainAgentStore((s) => s.dockWidth);
    const available = canDock(isDesktop, rowWidth);

    useLayoutEffect(() => {
        const row = ref.current?.parentElement;
        if (!row) return;
        const measure = () => setRowWidth(row.getBoundingClientRect().width);
        measure();
        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', measure);
            return () => window.removeEventListener('resize', measure);
        }
        const ro = new ResizeObserver(measure);
        ro.observe(row);
        return () => ro.disconnect();
    }, []);
    useEffect(() => {
        if (useMainAgentStore.getState().dockAvailable !== available) useMainAgentStore.setState({ dockAvailable: available });
    }, [available]);
    useEffect(() => () => { useMainAgentStore.setState({ dockAvailable: false }); }, []);

    const show = open && available && !onPage;
    // the notes dock shares this row on wide screens (NotesDock: hidden on /notes, /session/:id, /terminal/:id)
    const notesOpen = useLocalSetting('notesPanelOpen');
    const notesStored = useLocalSetting('notesPanelWidth');
    const notesWide = useMediaQuery('(min-width: 1100px)');
    const notesInRow = notesOpen && notesWide && !location.pathname.startsWith('/notes') && !/^\/(session|terminal)\/[^/]+/.test(location.pathname);
    const notesWidth = notesInRow ? resolveNotesPanelWidth(notesStored, typeof window === 'undefined' ? 0 : window.innerWidth) : null;
    const layout = dockLayout(rowWidth, stored, notesWidth);
    const maxWidth = layout.notes.kind === 'fit' ? Math.max(DOCK_MIN, rowWidth - DETAIL_RESERVE - DOCK_HANDLE - NOTES_HANDLE - NOTES_MIN) : dockMaxWidth(rowWidth);
    const notesKey = layout.notes.kind === 'fit' ? `fit:${layout.notes.maxWidth}` : layout.notes.kind;
    // the notes dock gives way per dockLayout (mainAgent.css reads these)
    useLayoutEffect(() => {
        const row = ref.current?.parentElement;
        if (!row) return;
        delete row.dataset.maNotes;
        row.style.removeProperty('--ma-notes-max');
        if (!show) { delete row.dataset.maDock; return; }
        row.dataset.maDock = 'open';
        if (layout.notes.kind === 'yield') row.dataset.maNotes = 'yield';
        else if (layout.notes.kind === 'fit') row.style.setProperty('--ma-notes-max', `${layout.notes.maxWidth}px`);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- notesKey stands for layout.notes
    }, [show, notesKey]);

    return (
        <div ref={ref} className="ma-dock-slot">
            {show && <Suspense fallback={null}><MainAgentDock width={layout.dock} maxWidth={maxWidth} notesYield={layout.notes.kind === 'yield'} /></Suspense>}
        </div>
    );
}

export function MainAgentEntry() {
    const { lang } = useTranslation();
    const copy = mainAgentCopy(lang);
    const state = useMainAgentState();
    const showing = useMainAgentStore(mainAgentDockShowing);
    const location = useLocation();
    const dot = mainAgentDot(state);
    const statusText = { idle: copy.statusIdle, thinking: copy.statusThinking, offline: copy.statusOffline, attention: copy.statusAttention, none: copy.statusNone }[dot];
    const current = showing || location.pathname.endsWith(MAIN_AGENT_PATH);
    return (
        <button type="button" className="sb-main-agent" data-main-agent-entry aria-expanded={current}
            title={`${copy.title} · ${MAIN_AGENT_CHORD_HINT}`} onClick={toggleMainAgent}>
            <Bot size={16} aria-hidden />
            <span className="sb-main-agent-name">{copy.title}</span>
            {state.kind !== 'loading' && dot !== 'idle' && <span className="sb-main-agent-status">{statusText}</span>}
            {state.kind === 'ready' && <StatusDot status={mainAgentStatusDot(dot)} pulse={dot === 'thinking'} title={statusText} />}
        </button>
    );
}
