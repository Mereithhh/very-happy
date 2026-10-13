/**
 * B-584: per-session PR/CI status, shared by the header chip (which polls)
 * and the git actions (which request an immediate refresh after commit/push/PR).
 *
 * Polling: 60s while the page is visible and the session active; hidden →
 * the tick is skipped (no visibility listener of our own — AGENTS 13; the next
 * tick after the page is visible again refreshes). `unavailable` (no gh, not
 * GitHub, …) backs off to 10 minutes. Results are tagged with the cwd they
 * were fetched for, so a late reply never lands on a different workspace
 * (Orca's checks-tab context-key idea).
 */
import { useEffect, useSyncExternalStore } from 'react';
import { storage } from '@/sync/storage';
import { shellFlavorFor } from '../diffComments/gitDiff';
import { platformOfSession } from '../diffComments/useGitFileDiff';
import { prViewCommand } from './gitShell';
import { runSync, sessionCwd } from './gitRunner';
import { classifyPrView, mergeLookup, pollDelayFor, PR_POLL_MS, type PrLookup } from './prStatus';


type Entry = { cwd: string; lookup: PrLookup; fetchedAt: number };

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function emit() {
    for (const l of [...listeners]) l();
}

export function refreshPrStatus(sessionId: string): Promise<void> {
    const running = inflight.get(sessionId);
    if (running) return running;
    const cwd = sessionCwd(sessionId);
    if (!cwd) return Promise.resolve();
    const task = (async () => {
        const flavor = shellFlavorFor(platformOfSession(sessionId));
        let lookup: PrLookup;
        try {
            const r = await runSync(sessionId, prViewCommand(flavor), 20_000);
            lookup = classifyPrView({ success: r.ok, exitCode: r.exitCode ?? -1, stdout: r.stdout, stderr: r.output });
        } catch {
            lookup = { kind: 'unavailable' };
        }
        // Workspace changed while we were waiting: drop the reply.
        if (sessionCwd(sessionId) !== cwd) return;
        const prev = entries.get(sessionId);
        entries.set(sessionId, { cwd, lookup: mergeLookup(prev?.cwd === cwd ? prev.lookup : undefined, lookup), fetchedAt: Date.now() });
        emit();
    })().finally(() => inflight.delete(sessionId));
    inflight.set(sessionId, task);
    return task;
}

export function getPrLookup(sessionId: string): PrLookup | null {
    const entry = entries.get(sessionId);
    if (!entry || entry.cwd !== sessionCwd(sessionId)) return null;
    return entry.lookup;
}

function subscribe(cb: () => void) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

export function usePrLookup(sessionId: string): PrLookup | null {
    return useSyncExternalStore(subscribe, () => getPrLookup(sessionId), () => null);
}

function shouldPoll(sessionId: string): boolean {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return false;
    const session = storage.getState().sessions[sessionId];
    return !!session?.active && !!session.metadata?.path;
}

/** Mounted by the session header: fetch now, then poll while visible. */
export function usePrStatusPolling(sessionId: string, cwd: string | null | undefined, active: boolean | undefined): void {
    useEffect(() => {
        if (!cwd || !active) return;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const tick = async () => {
            if (stopped) return;
            const entry = entries.get(sessionId);
            const due = !entry || entry.cwd !== cwd || Date.now() - entry.fetchedAt >= pollDelayFor(entry.lookup) - 1000;
            if (due && shouldPoll(sessionId)) await refreshPrStatus(sessionId);
            if (!stopped) timer = setTimeout(() => void tick(), PR_POLL_MS);
        };
        void tick();
        return () => { stopped = true; if (timer) clearTimeout(timer); };
    }, [sessionId, cwd, active]);
}
