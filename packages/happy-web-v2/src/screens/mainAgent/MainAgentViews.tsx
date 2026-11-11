/**
 * Main agent (B-916a) views that pull in the transcript renderer (Markdown):
 * lazy-loaded so the shell chunk stays small.
 *  - MainAgentDock (B-923): the desktop column — a resize separator on its
 *    left edge (pointer drag, keyboard, double-click resets, a drag far past
 *    the minimum collapses it) and the panel.
 *  - MainAgentPage: the /main-agent full-screen page (phones, narrow windows).
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppBack } from '@/app/appBack';
import { useKeyboardViewportPin } from '@/app/useKeyboardViewportPin';
import { useTranslation } from '@/i18n/useTranslation';
import { useMainAgentStore } from '@/assistant/mainAgentStore';
import { useMainAgentState } from '@/assistant/useMainAgent';
import { MainAgentPanel } from './MainAgentPanel';
import { clampDockWidth, dockKeyboardWidth, dockMaxWidth, dockRawWidthFromPointer, DOCK_MIN, shouldCollapseDock } from './mainAgentDock';
import { mainAgentToolCopy } from './toolCards/mainAgentToolCopy';

type Drag = { pointerId: number; edge: number; startX: number; active: boolean; width: number; collapse: boolean };

export function MainAgentDock({ width, rowWidth }: { width: number; rowWidth: number }) {
    const state = useMainAgentState();
    const { lang } = useTranslation();
    const copy = mainAgentToolCopy(lang);
    const ref = useRef<HTMLDivElement | null>(null);
    const openRequest = useMainAgentStore((s) => s.openRequest);
    const close = () => useMainAgentStore.getState().setDockOpen(false);
    const [live, setLive] = useState<{ width: number; collapse: boolean } | null>(null);
    const drag = useRef<Drag | null>(null);
    const shown = live?.width ?? width;

    // an explicit open (entry, ⌘K, ⌘⇧E) puts the caret in the composer; a column restored on load does not steal focus
    const mountedRequest = useRef(openRequest);
    useEffect(() => {
        if (openRequest === mountedRequest.current && openRequest === 0) return;
        const el = ref.current;
        (el?.querySelector<HTMLElement>('.ma-input') ?? el)?.focus();
    }, [openRequest, state.kind]);

    const end = (commit: boolean) => {
        const d = drag.current;
        drag.current = null;
        document.body.classList.remove('vh-col-resizing');
        setLive(null);
        if (!d || !d.active || !commit) return;
        if (d.collapse) close();
        else useMainAgentStore.getState().setDockWidth(d.width);
    };

    return (
        <>
            <div className="app-resize-handle ma-dock-handle" role="separator" aria-orientation="vertical" tabIndex={0}
                aria-label={copy.dockResize} title={copy.dockResizeHint}
                aria-valuemin={DOCK_MIN} aria-valuemax={dockMaxWidth(rowWidth)} aria-valuenow={shown}
                data-collapse={live?.collapse ? 'armed' : undefined}
                onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    const row = ref.current?.parentElement?.parentElement;
                    drag.current = { pointerId: e.pointerId, edge: row ? row.getBoundingClientRect().right : window.innerWidth, startX: e.clientX, active: false, width, collapse: false };
                    e.currentTarget.setPointerCapture?.(e.pointerId);
                }}
                onPointerMove={(e) => {
                    const d = drag.current;
                    if (!d || d.pointerId !== e.pointerId) return;
                    if (!d.active) {
                        if (Math.abs(e.clientX - d.startX) <= 4) return;
                        d.active = true;
                        document.body.classList.add('vh-col-resizing');
                    }
                    const raw = dockRawWidthFromPointer(e.clientX, d.edge);
                    d.width = clampDockWidth(raw, rowWidth);
                    d.collapse = shouldCollapseDock(raw);
                    setLive({ width: d.width, collapse: d.collapse });
                }}
                onPointerUp={() => end(true)}
                onPointerCancel={() => end(false)}
                onLostPointerCapture={() => { if (drag.current) end(true); }}
                onDoubleClick={() => useMainAgentStore.getState().setDockWidth(null)}
                onKeyDown={(e) => {
                    if (e.key === 'Escape' && drag.current) { e.preventDefault(); end(false); return; }
                    const next = dockKeyboardWidth(width, e.key, e.shiftKey, rowWidth);
                    if (next === null) return;
                    e.preventDefault();
                    useMainAgentStore.getState().setDockWidth(next);
                }}
            />
            <aside className={`ma-dock${live?.collapse ? ' ma-dock--collapse-armed' : ''}`} ref={ref} tabIndex={-1} style={{ width: shown }}
                data-testid="main-agent-dock"
                onKeyDown={(e) => { if (e.key === 'Escape' && !e.defaultPrevented && e.target === e.currentTarget) { e.preventDefault(); close(); } }}>
                <MainAgentPanel state={state} variant="dock" onClose={close} />
            </aside>
        </>
    );
}

export function MainAgentPage() {
    const state = useMainAgentState();
    const navigate = useNavigate();
    const { canGoBack, goBack } = useAppBack();
    const ref = useRef<HTMLDivElement | null>(null);
    useKeyboardViewportPin(ref);
    return (
        <div className="ma-page" ref={ref}>
            <MainAgentPanel state={state} variant="page" onClose={() => (canGoBack ? void goBack() : navigate('/'))} />
        </div>
    );
}
