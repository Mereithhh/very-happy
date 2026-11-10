/**
 * Main agent (B-916a) shell pieces:
 *  - MainAgentHost: mounted once in AppLayout. Keeps the KV pointer fresh,
 *    renders the desktop drawer, and on phones turns "open" into the
 *    full-screen /main-agent page.
 *  - MainAgentPage: the /main-agent route (phone full screen; desktop deep
 *    links land here too and render the same panel in the detail pane).
 *  - MainAgentEntry: the always-visible sidebar row above 新建会话.
 */

import { lazy, Suspense, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Bot } from 'lucide-react';
import { StatusDot } from '@/ui';
import { useIsDesktop } from '@/app/useMediaQuery';
import { useTranslation } from '@/i18n/useTranslation';
import { mainAgentCopy } from '@/assistant/mainAgentCopy';
import { openMainAgent, useMainAgentStore } from '@/assistant/mainAgentStore';
import { useMainAgentPointerSync, useMainAgentState } from '@/assistant/useMainAgent';
import { mainAgentDot, mainAgentStatusDot } from '@/assistant/mainAgent';
import { isMainAgentChord, MAIN_AGENT_CHORD_HINT } from '@/screens/command/mainAgentPalette';
import './mainAgent.css';

const MainAgentDrawer = lazy(() => import('./MainAgentViews').then((m) => ({ default: m.MainAgentDrawer })));

export const MAIN_AGENT_PATH = '/main-agent';

/** The page under the shell's root (`/` in the app; the DEV device harness mounts it elsewhere). */
export function mainAgentPath(rootPath = '/'): string {
    return `${rootPath.replace(/\/$/, '')}${MAIN_AGENT_PATH}`;
}

export function MainAgentHost({ rootPath = '/' }: { rootPath?: string } = {}) {
    useMainAgentPointerSync();
    const isDesktop = useIsDesktop();
    const navigate = useNavigate();
    const location = useLocation();
    const open = useMainAgentStore((s) => s.drawerOpen);
    const pagePath = mainAgentPath(rootPath);
    const onPage = location.pathname === pagePath;

    // phones (and the page itself): "open" = the full-screen page, never a drawer
    useEffect(() => {
        if (!open || (isDesktop && !onPage)) return;
        useMainAgentStore.getState().setDrawerOpen(false);
        if (!onPage) navigate(pagePath);
    }, [open, isDesktop, onPage, navigate, pagePath]);

    // ⌘⇧E toggles the drawer anywhere (⌘J is notes; ⌘⇧A is the browser's tab search)
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.defaultPrevented) return;
            if (!isMainAgentChord(e)) return;
            e.preventDefault();
            const st = useMainAgentStore.getState();
            if (st.drawerOpen) st.setDrawerOpen(false);
            else openMainAgent();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    if (!open || !isDesktop || onPage) return null;
    return <Suspense fallback={null}><MainAgentDrawer /></Suspense>;
}

export function MainAgentEntry() {
    const { lang } = useTranslation();
    const copy = mainAgentCopy(lang);
    const state = useMainAgentState();
    const open = useMainAgentStore((s) => s.drawerOpen);
    const location = useLocation();
    const dot = mainAgentDot(state);
    const statusText = { idle: copy.statusIdle, thinking: copy.statusThinking, offline: copy.statusOffline, attention: copy.statusAttention, none: copy.statusNone }[dot];
    const current = open || location.pathname.endsWith(MAIN_AGENT_PATH);
    return (
        <button type="button" className="sb-main-agent" data-main-agent-entry aria-expanded={current}
            title={`${copy.title} · ${MAIN_AGENT_CHORD_HINT}`} onClick={() => (open ? useMainAgentStore.getState().setDrawerOpen(false) : openMainAgent())}>
            <Bot size={16} aria-hidden />
            <span className="sb-main-agent-name">{copy.title}</span>
            {state.kind !== 'loading' && dot !== 'idle' && <span className="sb-main-agent-status">{statusText}</span>}
            {state.kind === 'ready' && <StatusDot status={mainAgentStatusDot(dot)} pulse={dot === 'thinking'} title={statusText} />}
        </button>
    );
}
