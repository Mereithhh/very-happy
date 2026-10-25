/**
 * B-804: the viewed session's message catch-up, made visible.
 *
 * resume / reconnect / recovered / a seq gap start a catch-up (sync.ts); its
 * promise settles when the messages sync has drained. While it runs:
 *  - after CATCH_UP_SHOW_MS the top bar says 「同步中…」 (B-799's
 *    beginNetworkSync, one holder per session) and the chat's bottom line
 *    shows — a catch-up that lands sooner shows nothing (no flicker);
 *  - after CATCH_UP_SLOW_MS (the request deadline + 2s) the line turns into
 *    「连接不稳定 · 重试」.
 * A new catch-up for a session that is already catching up joins it: the
 * line ends when the LATEST one settles, and a retry starts the slow clock over.
 */
import { create } from 'zustand';
import { beginNetworkSync } from './networkStatus';
import { SYNC_READ_TIMEOUT_MS } from './requestDeadline';

export const CATCH_UP_SHOW_MS = 300;
/** The messages GET deadline (B-803) plus 2s to merge what it returned. */
export const CATCH_UP_SLOW_MS = SYNC_READ_TIMEOUT_MS + 2_000;

export type CatchUpPhase = 'syncing' | 'slow';

export const catchUpStore = create<{ sessions: Record<string, CatchUpPhase> }>(() => ({ sessions: {} }));

type Tracking = {
    generation: number;
    showTimer: ReturnType<typeof setTimeout> | null;
    slowTimer: ReturnType<typeof setTimeout> | null;
    release: (() => void) | null;
};

const tracking = new Map<string, Tracking>();

function setPhase(sessionId: string, phase: CatchUpPhase | null) {
    catchUpStore.setState((state) => {
        if ((state.sessions[sessionId] ?? null) === phase) return state;
        const sessions = { ...state.sessions };
        if (phase) sessions[sessionId] = phase;
        else delete sessions[sessionId];
        return { sessions };
    });
}

function armSlow(sessionId: string, entry: Tracking, slowMs: number) {
    if (entry.slowTimer) clearTimeout(entry.slowTimer);
    entry.slowTimer = setTimeout(() => {
        entry.slowTimer = null;
        setPhase(sessionId, 'slow');
    }, slowMs);
}

/**
 * Track one catch-up of `sessionId`; `done` settles when its data is in (or it gave up).
 * `slowMs` (B-812): subscribe mode turns 「连接不稳定」 after the 5s ack deadline + 3s.
 */
export function trackCatchUp(sessionId: string, done: Promise<unknown>, opts?: { slowMs?: number }): void {
    const slowMs = opts?.slowMs ?? CATCH_UP_SLOW_MS;
    let entry = tracking.get(sessionId);
    if (!entry) {
        const created: Tracking = { generation: 0, showTimer: null, slowTimer: null, release: null };
        created.showTimer = setTimeout(() => {
            created.showTimer = null;
            created.release = beginNetworkSync(`messages:${sessionId}`);
            if (catchUpStore.getState().sessions[sessionId] !== 'slow') setPhase(sessionId, 'syncing');
        }, CATCH_UP_SHOW_MS);
        entry = created;
        tracking.set(sessionId, entry);
    } else if (catchUpStore.getState().sessions[sessionId] === 'slow') {
        // A retry (or a fresh resume) while slow: back to 「同步中」, a full deadline again.
        setPhase(sessionId, 'syncing');
    }
    armSlow(sessionId, entry, slowMs);
    const generation = ++entry.generation;
    const finish = () => {
        const current = tracking.get(sessionId);
        if (!current || current.generation !== generation) return;
        if (current.showTimer) clearTimeout(current.showTimer);
        if (current.slowTimer) clearTimeout(current.slowTimer);
        current.release?.();
        tracking.delete(sessionId);
        setPhase(sessionId, null);
    };
    done.then(finish, finish);
}

/** Stop showing a session's catch-up (its sync was torn down). */
export function forgetCatchUp(sessionId: string): void {
    const entry = tracking.get(sessionId);
    if (!entry) return;
    if (entry.showTimer) clearTimeout(entry.showTimer);
    if (entry.slowTimer) clearTimeout(entry.slowTimer);
    entry.release?.();
    tracking.delete(sessionId);
    setPhase(sessionId, null);
}

export function useCatchUpPhase(sessionId: string): CatchUpPhase | null {
    return catchUpStore((state) => state.sessions[sessionId] ?? null);
}
