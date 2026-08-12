/**
 * terminalSync — the ONE place terminal lists/agent states enter the app,
 * in two lanes (feature-detected per machine, see terminalPushOps.ts):
 *
 *   PUSH lane (new daemons): the daemon tracks its own list and writes every
 *   change into daemonState.webTerminals; the server broadcasts
 *   `update-machine` and the storage store applies it. This module watches
 *   the machines slice and, whenever a machine's trusted snapshot advances
 *   (updatedAt changed), feeds it into useTerminalSessions.applyPush() and
 *   useTerminalAgentStates.ingest(). Zero polling; offline machines are fed
 *   from the server-persisted daemonState the same way.
 *
 *   POLL lane (legacy fallback): machines that are online WITHOUT a trusted
 *   snapshot (old or downgraded daemon) keep the previous behavior verbatim:
 *   `machineListTerminals` every 10s (30s hidden), reconciled into the
 *   KV-backed record list. The lane a machine is in can change at runtime —
 *   the poll cycle re-partitions whenever the machine set (or any machine's
 *   trust) changes.
 *
 * Singleton by module-level reference counting: the first mounted
 * `useTerminalSync()` starts it, the last unmount stops it. AppLayout is the
 * one intended caller; the refcount just makes an accidental second mount
 * (StrictMode double-effects, future layouts) harmless. Review red line:
 * `machineListTerminals` must have no other caller (see terminalAgentState.ts).
 */
import { useEffect } from 'react';
import { storage } from '@/sync/storage';
import { machineLabel } from '@/utils/machineUtils';
import { machineListTerminals } from '@/sync/ops';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { useTerminalAgentStates } from '@/sync/terminalAgentState';
import { partitionMachinesForSync } from '@/sync/terminalPushOps';
import type { Machine } from '@/sync/storageTypes';

function allMachines(): Machine[] {
  const state = storage.getState();
  if (!state.isDataReady) return [];
  return Object.values(state.machines);
}

/** machineId → updatedAt of the last snapshot fed into the stores. Module
 *  state (not store state): it's plumbing that says "already applied", and
 *  resets naturally with the loop's lifecycle. */
let appliedPushVersions = new Map<string, number>();

/** Feed every machine's trusted snapshot into the stores (idempotent per
 *  updatedAt), and demote machines whose snapshot lost trust (downgraded
 *  daemon) back to the legacy path. */
function syncPushes(): void {
  const machines = allMachines();
  const { pushed } = partitionMachinesForSync(machines);
  const trusted = new Set(pushed.map((p) => p.id));
  for (const { id, snapshot } of pushed) {
    if (appliedPushVersions.get(id) === snapshot.updatedAt) continue;
    appliedPushVersions.set(id, snapshot.updatedAt);
    const machine = machines.find((m) => m.id === id)!;
    useTerminalSessions.getState().applyPush(id, machineLabel(machine), snapshot.terminals);
    useTerminalAgentStates.getState().ingest(id, snapshot.terminals);
  }
  for (const id of [...appliedPushVersions.keys()]) {
    if (trusted.has(id)) continue;
    appliedPushVersions.delete(id);
    useTerminalSessions.getState().clearPush(id);
  }
}

/** The poll lane's membership, as a change-detection key. */
function pollIdsKey(): string {
  return partitionMachinesForSync(allMachines()).pollIds.sort().join(',');
}

/** One polling cycle for a fixed machine set — the legacy 10s/30s loop,
 *  body unchanged from the pre-push reconcile loop. Returns its cleanup. */
function startCycle(pollMachineIds: string): () => void {
  let cancelled = false;
  const poll = () => {
    for (const id of pollMachineIds.split(',')) {
      const m = allMachines().find((x) => x.id === id);
      const name = m ? machineLabel(m) : id.slice(0, 8);
      machineListTerminals(id).then((live) => {
        if (cancelled) return;
        // The machine may have gained push trust while the RPC was in flight —
        // a push-fed machine must never be touched by poll results.
        if (useTerminalSessions.getState().isPushed(id)) return;
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

/** Run both lanes while the refcount is >0: a plain store subscription feeds
 *  pushes and re-partitions the poll cycle whenever the pollable set changes. */
function startLoop(): () => void {
  appliedPushVersions = new Map();
  syncPushes();
  let currentIds = pollIdsKey();
  let stopCycle: (() => void) | null = currentIds ? startCycle(currentIds) : null;
  const unsubscribe = storage.subscribe(() => {
    syncPushes();
    const ids = pollIdsKey();
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
export function useTerminalSync(): void {
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
