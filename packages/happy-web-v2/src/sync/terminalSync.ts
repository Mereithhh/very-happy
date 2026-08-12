/**
 * terminalSync — the ONE place terminal lists/agent states enter the app.
 *
 * Push lane (the only lane since the legacy 10s poll was retired, 2026-08):
 * the daemon tracks its own list and writes every change into
 * daemonState.webTerminals; the server broadcasts `update-machine` and the
 * storage store applies it. This module watches the machines slice and,
 * whenever a machine's trusted snapshot advances (updatedAt changed), feeds
 * it into useTerminalSessions.applyPush() and useTerminalAgentStates.ingest().
 * Zero polling; offline machines are fed from the server-persisted
 * daemonState the same way. Machines without a trusted snapshot (daemon
 * < 0.2.27, or downgraded) contribute nothing — their terminal list simply
 * doesn't update (docs/channels.md states the compat floor).
 *
 * Singleton by module-level reference counting: the first mounted
 * `useTerminalSync()` starts it, the last unmount stops it. AppLayout is the
 * one intended caller; the refcount just makes an accidental second mount
 * (StrictMode double-effects, future layouts) harmless.
 */
import { useEffect } from 'react';
import { storage } from '@/sync/storage';
import { machineLabel } from '@/utils/machineUtils';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { useTerminalAgentStates } from '@/sync/terminalAgentState';
import { pushedMachineSnapshots } from '@/sync/terminalPushOps';
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
 *  updatedAt), and drop machines whose snapshot lost trust (downgraded
 *  daemon) so stale data stops rendering. */
function syncPushes(): void {
  const machines = allMachines();
  const pushed = pushedMachineSnapshots(machines);
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

/** Feed pushes while the refcount is >0: a plain store subscription applies
 *  every advanced snapshot as `update-machine` broadcasts land. */
function startLoop(): () => void {
  appliedPushVersions = new Map();
  syncPushes();
  return storage.subscribe(() => syncPushes());
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
