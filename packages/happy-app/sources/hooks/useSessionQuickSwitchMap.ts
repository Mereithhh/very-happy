import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { storage } from '@/sync/storage';

export const QUICK_SWITCH_MAX = 9;

/**
 * Builds the Cmd+1..9 quick-switch order. We mirror the sidebar's "active
 * sessions" ordering (active sessions, newest createdAt first) and take the
 * first 9 so the badge numbers shown on hover-with-Cmd line up exactly with
 * what Cmd+<n> jumps to. createdAt is stable (set once), so the order doesn't
 * shuffle on every heartbeat.
 *
 * Returns both:
 *  - byNumber: 1..9 -> sessionId (handler uses this to navigate)
 *  - byId: sessionId -> 1..9 (rows use this to render their badge)
 */
export interface SessionQuickSwitchMap {
    byNumber: Record<number, string>;
    byId: Record<string, number>;
}

const EMPTY: SessionQuickSwitchMap = { byNumber: {}, byId: {} };

export function useSessionQuickSwitchMap(): SessionQuickSwitchMap {
    // Subscribe shallowly to the sessions record; recompute only when it changes.
    const sessions = storage(useShallow((state) => state.sessions));

    return React.useMemo(() => {
        const active = Object.values(sessions)
            // Mirror the sidebar's "active" predicate (storage.isSessionActive),
            // which is just the active flag — no timeout checks.
            .filter((session) => session.active)
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, QUICK_SWITCH_MAX);

        if (active.length === 0) return EMPTY;

        const byNumber: Record<number, string> = {};
        const byId: Record<string, number> = {};
        active.forEach((session, index) => {
            const n = index + 1;
            byNumber[n] = session.id;
            byId[session.id] = n;
        });
        return { byNumber, byId };
    }, [sessions]);
}
