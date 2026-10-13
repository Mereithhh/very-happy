/**
 * B-587: opening a hibernated session wakes it (once per hibernation; a
 * failure is left to the banner's Retry). See `shouldAutoWake`.
 */
import { useEffect, useRef } from 'react';
import { storage } from '@/sync/storage';
import { restoreSession, useRestoreState } from './sessionRestore';
import { shouldAutoWake } from './sessionHibernation';

const attempted = new Set<string>();

export function useHibernationAutoWake(sessionId: string | undefined): void {
    const opened = useRef<{ id: string | undefined; at: number }>({ id: undefined, at: 0 });
    if (opened.current.id !== sessionId) opened.current = { id: sessionId, at: Date.now() };
    const session = storage((s) => (sessionId ? s.sessions[sessionId] : undefined));
    const machineOnline = storage((s) => {
        const mid = sessionId ? s.sessions[sessionId]?.metadata?.machineId : undefined;
        return !!(mid && s.machines[mid]?.active);
    });
    const restore = useRestoreState(sessionId ?? '');
    const restoreBusy = restore?.phase === 'spawning' || restore?.phase === 'awaiting-online';
    useEffect(() => {
        if (!sessionId) return;
        const key = shouldAutoWake({ sessionId, session, machineOnline, restoreBusy, attempted, openedAt: opened.current.at });
        if (!key) return;
        attempted.add(key);
        void restoreSession(sessionId);
    }, [sessionId, session, machineOnline, restoreBusy]);
}

export function resetHibernationAutoWakeForTest(): void {
    attempted.clear();
}
