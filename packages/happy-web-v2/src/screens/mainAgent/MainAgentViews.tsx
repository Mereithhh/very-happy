/**
 * Main agent (B-916a) views that pull in the transcript renderer (Markdown):
 * lazy-loaded so the shell chunk stays small.
 */

import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppBack } from '@/app/appBack';
import { useKeyboardViewportPin } from '@/app/useKeyboardViewportPin';
import { useMainAgentStore } from '@/assistant/mainAgentStore';
import { useMainAgentState } from '@/assistant/useMainAgent';
import { MainAgentPanel } from './MainAgentPanel';

export function MainAgentDrawer() {
    const state = useMainAgentState();
    const ref = useRef<HTMLDivElement | null>(null);
    const close = () => useMainAgentStore.getState().setDrawerOpen(false);
    useEffect(() => {
        // focus the composer (or the panel) on open so typing goes straight in
        const el = ref.current;
        (el?.querySelector<HTMLElement>('.ma-input') ?? el)?.focus();
    }, [state.kind]);
    return (
        <div className="ma-drawer" ref={ref} tabIndex={-1}
            onKeyDown={(e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close(); } }}>
            <MainAgentPanel state={state} variant="drawer" onClose={close} />
        </div>
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
