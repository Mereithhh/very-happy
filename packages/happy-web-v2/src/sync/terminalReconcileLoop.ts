/**
 * terminalReconcileLoop — THE single `machineListTerminals` poll loop, hoisted
 * out of Sidebar so the terminal list / agent states stay fresh on every
 * authed screen (Board, collapsed sidebar, mobile detail), not only while the
 * expanded desktop sidebar happens to be mounted.
 *
 * What it does (verbatim from the old Sidebar effect): reconcile the
 * client-owned terminal list against each online machine's REAL live tmux
 * sessions (adopt orphans, drop dead records) and feed every result into the
 * terminalAgentState store. Runs on start / online-machine-set change, then
 * every 10s — slowed to 30s while the tab is hidden rather than paused
 * outright, because the needs_input notification only matters while the user
 * is away (a fully paused poll could never fire it).
 *
 * Singleton by module-level reference counting: the first mounted
 * `useTerminalReconcileLoop()` starts the loop, the last unmount stops it.
 * AppLayout is the one intended caller; the refcount just makes an accidental
 * second mount (StrictMode double-effects, future layouts) harmless instead
 * of a polling multiplier. Review red line: `machineListTerminals` must have
 * no other caller (see terminalAgentState.ts header).
 */
import { useEffect } from 'react';
import { storage } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { machineListTerminals } from '@/sync/ops';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { useTerminalAgentStates } from '@/sync/terminalAgentState';
import type { Machine } from '@/sync/storageTypes';

function allMachines(): Machine[] {
  const state = storage.getState();
  if (!state.isDataReady) return [];
  return Object.values(state.machines);
}

function onlineMachineIdsKey(): string {
  return allMachines()
    .filter(isMachineOnline)
    .map((m) => m.id)
    .sort()
    .join(',');
}

/** One polling cycle for a fixed online-machine set. Returns its cleanup.
 *  Body mirrors the former Sidebar effect one-to-one. */
function startCycle(onlineMachineIds: string): () => void {
  let cancelled = false;
  const poll = () => {
    for (const id of onlineMachineIds.split(',')) {
      const m = allMachines().find((x) => x.id === id);
      const name = (m as any)?.metadata?.displayName || (m as any)?.metadata?.host || id.slice(0, 8);
      machineListTerminals(id).then((live) => {
        if (cancelled) return;
        useTerminalSessions.getState().reconcile(id, name, live); // null-safe (no-op on failed query)
        if (live) useTerminalAgentStates.getState().ingest(id, live); // failure → keep last known states
      });
    }
  };
  poll();
  let timer: ReturnType<typeof setInterval> | null = null;
  const schedule = () => {
    if (timer) clearInterval(timer);
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    timer = setInterval(poll, hidden ? 30_000 : 10_000);
  };
  schedule();
  const onVisibility = () => {
    schedule();
    if (document.visibilityState === 'visible') poll();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  return () => {
    cancelled = true;
    if (timer) clearInterval(timer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
  };
}

/** Run the loop while the refcount is >0: watch the online-machine set via a
 *  plain store subscription (this is not a React component) and restart the
 *  cycle whenever it changes — same as the old effect's [onlineMachineIds]
 *  dependency. */
function startLoop(): () => void {
  let currentIds = onlineMachineIdsKey();
  let stopCycle: (() => void) | null = currentIds ? startCycle(currentIds) : null;
  const unsubscribe = storage.subscribe(() => {
    const ids = onlineMachineIdsKey();
    if (ids === currentIds) return;
    currentIds = ids;
    stopCycle?.();
    stopCycle = ids ? startCycle(ids) : null;
  });
  return () => {
    unsubscribe();
    stopCycle?.();
    stopCycle = null;
  };
}

let refCount = 0;
let stopLoop: (() => void) | null = null;

/** Mount-scoped handle on the singleton loop (see module header). */
export function useTerminalReconcileLoop(): void {
  useEffect(() => {
    refCount += 1;
    if (refCount === 1) stopLoop = startLoop();
    return () => {
      refCount -= 1;
      if (refCount === 0) {
        stopLoop?.();
        stopLoop = null;
      }
    };
  }, []);
}
