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
 * Realtime activity lane (`terminal-activity`): the same daemon also relays a
 * tiny EPHEMERAL frame whenever a terminal's activity time actually moves. It
 * exists because the push lane above is deliberately coarse — one daemonState
 * write costs a CAS + DB write + broadcast, so activity only participates in
 * its change signature at 60s granularity, which meant a terminal that was
 * merely PRINTING could take a minute to float to the top of the sidebar.
 * These frames are NOT state: they go straight into the in-memory activity
 * overlay used for ordering, never into the terminal list, the machines slice
 * or daemonState. A daemon too old to send them, a server too old to relay
 * them, or a dropped frame all degrade to the pushed `activityAt` — i.e. to
 * exactly the pre-feature behaviour.
 *
 * Singleton by module-level reference counting: the first mounted
 * `useTerminalSync()` starts it, the last unmount stops it. AppLayout is the
 * one intended caller; the refcount just makes an accidental second mount
 * (StrictMode double-effects, future layouts) harmless.
 */
import { useLayoutEffect } from 'react';
import { storage } from '@/sync/storage';
import { apiSocket } from '@/sync/apiSocket';
import { applyRemoteTerminalActivity } from '@/sync/activityOverlayStore';
import { machineLabel } from '@/utils/machineUtils';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { useTerminalAgentStates } from '@/sync/terminalAgentState';
import { pushedMachineSnapshots } from '@/sync/terminalPushOps';
import { closedTerminalsOf } from '@/sync/closedTerminals';
import { pruneTerminalViewOverrides } from '@/sync/terminalViewPref';
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
  let applied = false;
  for (const { id, snapshot } of pushed) {
    if (appliedPushVersions.get(id) === snapshot.updatedAt) continue;
    appliedPushVersions.set(id, snapshot.updatedAt);
    applied = true;
    const machine = machines.find((m) => m.id === id)!;
    useTerminalSessions.getState().applyPush(id, machineLabel(machine), snapshot.terminals);
    useTerminalAgentStates.getState().ingest(id, snapshot.terminals);
  }
  for (const id of [...appliedPushVersions.keys()]) {
    if (trusted.has(id)) continue;
    appliedPushVersions.delete(id);
    useTerminalSessions.getState().clearPush(id);
  }
  // B-105: the per-terminal view overrides (localSettings) ride the same
  // ingestion beat — a terminal with a closed record no longer needs its
  // override, and pruning here bounds the record's growth (M-3③). Only when
  // a snapshot actually advanced; a no-op prune returns the same object, so
  // this can't ping-pong with the storage subscription that re-runs us.
  if (applied) {
    const closed = new Set<string>();
    for (const m of machines) {
      for (const r of closedTerminalsOf(m.daemonState)) closed.add(r.id);
    }
    if (closed.size > 0) {
      const st = storage.getState();
      const cur = st.localSettings.terminalViewOverrides;
      const next = pruneTerminalViewOverrides(cur, closed);
      if (next !== cur) st.applyLocalSettings({ terminalViewOverrides: next });
    }
  }
}

/** One relayed realtime frame. Defensive about the payload: it comes off the
 *  wire from a daemon of unknown version, and `applyRemoteTerminalActivity`
 *  drops anything malformed item-by-item. */
function onTerminalActivity(data: unknown): void {
  const terminals = (data as { terminals?: unknown } | null)?.terminals;
  if (!Array.isArray(terminals)) return;
  applyRemoteTerminalActivity(terminals as Array<{ id: string; activityAt: number }>);
}

/** Feed pushes while the refcount is >0: a plain store subscription applies
 *  every advanced snapshot as `update-machine` broadcasts land, plus the
 *  realtime activity frames. The socket listener needs no reconnect handling:
 *  it is keyed by event name on the long-lived apiSocket dispatcher, and
 *  missing frames while the socket is down costs only freshness — the
 *  reconnect's daemonState push re-seeds the durable value. */
function startLoop(): () => void {
  appliedPushVersions = new Map();
  syncPushes();
  // ⚠️ apiSocket.onMessage is ONE handler per event name, and its unsubscribe
  // deletes by name without checking identity. This module is the only
  // registrant for 'terminal-activity' — a second one anywhere would silently
  // replace this one (and teardown order could delete the newer). Keep it that
  // way: route additional consumers through the activity overlay store.
  const offActivity = apiSocket.onMessage('terminal-activity', onTerminalActivity);
  const unsubscribe = storage.subscribe(() => syncPushes());
  return () => {
    offActivity();
    unsubscribe();
  };
}

let refCount = 0;
let stopLoop: (() => void) | null = null;

/** Mount-scoped handle on the singleton loop (see module header). */
export function useTerminalSync(): void {
  // Initial machine snapshots are already in the restored storage store when
  // AppLayout mounts. Feed them in a layout effect so HomeGate is rerendered
  // before the browser can paint a false "zero terminals" workspace guide.
  // Later push updates still use the same ordinary store subscription.
  useLayoutEffect(() => {
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
