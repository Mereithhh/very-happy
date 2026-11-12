/**
 * B-587: opening a hibernated session wakes it (once per hibernation; a
 * failure is left to the banner's Retry). See `shouldAutoWake`. B-933: not
 * when the screen was reached by an archive/close landing (./closeLanding).
 */
import { useEffect, useRef } from 'react';
import { storage } from '@/sync/storage';
import { restoreSession, useRestoreState } from './sessionRestore';
import { latestUserMessageAt, shouldAutoWake } from './sessionHibernation';
import { isCloseLanding } from './closeLanding';

const attempted = new Set<string>();

export function useHibernationAutoWake(sessionId: string | undefined): void {
    const opened = useRef<{ id: string | undefined; at: number; landed: boolean }>({ id: undefined, at: 0, landed: false });
    if (opened.current.id !== sessionId) {
        const at = Date.now();
        // B-933: decided once per visit — the hibernated state may only reach this tab later.
        opened.current = { id: sessionId, at, landed: !!sessionId && isCloseLanding(sessionId, at) };
    }
    const session = storage((s) => (sessionId ? s.sessions[sessionId] : undefined));
    const machineOnline = storage((s) => {
        const mid = sessionId ? s.sessions[sessionId]?.metadata?.machineId : undefined;
        return !!(mid && s.machines[mid]?.active);
    });
    const latestUserAt = storage((s) => (sessionId ? latestUserMessageAt(s.sessionMessages[sessionId]?.messages ?? []) : undefined));
    const restore = useRestoreState(sessionId ?? '');
    const restoreBusy = restore?.phase === 'spawning' || restore?.phase === 'awaiting-online';
    useEffect(() => {
        if (!sessionId) return;
        const key = shouldAutoWake({ sessionId, session, machineOnline, restoreBusy, attempted, openedAt: opened.current.at, latestUserMessageAt: latestUserAt, openedByCloseLanding: opened.current.landed });
        if (!key) return;
        attempted.add(key);
        void restoreSession(sessionId);
    }, [sessionId, session, machineOnline, restoreBusy, latestUserAt]);
}

export function resetHibernationAutoWakeForTest(): void {
    attempted.clear();
}
