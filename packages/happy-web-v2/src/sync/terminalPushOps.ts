/**
 * Pure operations for the PUSHED terminal list — the daemon-driven model that
 * replaces per-client `list-terminals` polling for new daemons. No zustand /
 * network imports so every rule here is unit-testable.
 *
 * Truth model: a new daemon tracks its own tmux `vh-*` list (membership,
 * titles, agent states, activity) and writes each CHANGE into
 * `daemonState.webTerminals`. The server persists daemonState and broadcasts
 * `update-machine`, so:
 *   - online machines: the push IS the list — no polling, no client-side
 *     reconciliation, deletion propagates by absence (no tombstones);
 *   - offline machines: the server's persisted daemonState still carries the
 *     last list — display works with zero client-side storage.
 *
 * Trust rule (feature detection + downgrade safety): the snapshot counts only
 * when `updatedAt >= startedAt`, i.e. it was written by the CURRENT daemon
 * run. New daemons stamp both with the same clock reading in their connect
 * write, so trust never flaps across reconnects. A daemon DOWNGRADED to a
 * pre-push version spreads the stale field forward (`{...state}`) but bumps
 * `startedAt` without restamping — the rule fails and the client falls back
 * to the legacy poll+KV path for that machine. Old daemons never have the
 * field at all.
 *
 * Optimistic overlay: pushes round-trip through the daemon (~RPC + push), so
 * local mutations render immediately via a small overlay that the next
 * pushes confirm and clear:
 *   - created: a just-created terminal, shown until its id appears in a push
 *     (the daemon creates the tmux session on `open-terminal`) or the TTL
 *     expires (open never happened — honest disappearance);
 *   - renames: the new title, shown until the push carries it back or the TTL
 *     expires (rename never landed — honest revert);
 *   - removed: a killed terminal hidden until the push confirms its absence
 *     or the TTL expires (kill never landed — the row honestly returns; this
 *     intentionally differs from the legacy tombstone model, which hid a
 *     terminal forever even when the kill RPC never reached the machine).
 */
import type { MachineTerminal } from '@/sync/ops';
import type { TerminalSession } from '@/sync/terminalListOps';

/** A trusted webTerminals snapshot read out of a machine's daemonState. */
export interface PushedSnapshot {
  updatedAt: number;
  terminals: MachineTerminal[];
}

/** One machine's applied push, as held by the terminalSessions store. */
export interface MachinePush {
  machineName: string;
  terminals: MachineTerminal[];
}

export interface PushOverlay {
  /** Optimistic rows for terminals created locally, keyed into pushes by id. */
  created: TerminalSession[];
  /** id → optimistic title for renames the daemon hasn't pushed back yet. */
  renames: Record<string, { title: string; at: number }>;
  /** id → when the local kill hid this terminal. */
  removed: Record<string, number>;
}

export const EMPTY_OVERLAY: PushOverlay = { created: [], renames: {}, removed: {} };

/** How long an optimistic creation stays visible without a confirming push. */
export const CREATE_OVERLAY_TTL_MS = 60_000;
/** How long an optimistic rename overrides the pushed title. */
export const RENAME_OVERLAY_TTL_MS = 15_000;
/** How long a killed terminal stays hidden without a confirming push. */
export const REMOVE_OVERLAY_TTL_MS = 30_000;

/**
 * Read a machine's daemonState into a trusted snapshot, or null when the
 * machine must be handled by the legacy poll+KV path. See the module header
 * for the trust rule. Tolerant of any daemonState shape (it's untyped JSON
 * from the wire): malformed items are dropped, a malformed container is null.
 */
export function trustedWebTerminals(daemonState: any): PushedSnapshot | null {
  const wt = daemonState?.webTerminals;
  if (!wt || typeof wt.updatedAt !== 'number' || !Array.isArray(wt.terminals)) return null;
  const startedAt = typeof daemonState.startedAt === 'number' ? daemonState.startedAt : 0;
  if (wt.updatedAt < startedAt) return null; // stale field from a previous (newer-versioned) run
  const terminals = (wt.terminals as any[]).filter(
    (t): t is MachineTerminal => !!t && typeof t.id === 'string' && t.id.length > 0,
  );
  return { updatedAt: wt.updatedAt, terminals };
}

/**
 * Feature-detect partition for the sync loop: machines with a trusted
 * snapshot are PUSH-fed; machines that are online WITHOUT one keep the legacy
 * 10s poll (old or downgraded daemons). Offline machines without a snapshot
 * are neither (their KV records remain the only display source).
 */
export function partitionMachinesForSync(
  machines: Array<{ id: string; active: boolean; daemonState: any }>,
): { pushed: Array<{ id: string; snapshot: PushedSnapshot }>; pollIds: string[] } {
  const pushed: Array<{ id: string; snapshot: PushedSnapshot }> = [];
  const pollIds: string[] = [];
  for (const m of machines) {
    const snapshot = trustedWebTerminals(m.daemonState);
    if (snapshot) pushed.push({ id: m.id, snapshot });
    else if (m.active) pollIds.push(m.id);
  }
  return { pushed, pollIds };
}

/** Map one pushed terminal into the store's row shape. Same title fallback
 *  and `manual` semantics as legacy orphan adoption (terminalListOps). */
function pushRowOf(t: MachineTerminal, machineId: string, machineName: string): TerminalSession {
  const title = (t.title ?? '').trim();
  return {
    id: t.id,
    machineId,
    machineName,
    title: title || machineName || 'Terminal',
    manual: !!title,
    createdAt: t.createdAt ?? 0,
    updatedAt: t.activityAt ?? t.createdAt,
  };
}

/**
 * Compose the single list consumers render:
 *   1. optimistic creations (newest, mirroring legacy create()'s prepend),
 *   2. pushed rows per machine (created-desc, machines in stable id order),
 *      with rename/remove overlays applied,
 *   3. legacy KV rows for machines WITHOUT a push (old daemons + offline
 *      machines that never pushed) — tombstones ride along untouched and are
 *      hidden by activeTerminals() at the consumers, exactly as before.
 */
export function composeTerminalList(
  kv: TerminalSession[],
  pushes: Record<string, MachinePush>,
  overlay: PushOverlay,
  now: number,
): TerminalSession[] {
  const rows: TerminalSession[] = [];
  const pushedIds = new Set<string>();
  for (const machineId of Object.keys(pushes).sort()) {
    const p = pushes[machineId];
    const sorted = [...p.terminals].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    for (const t of sorted) {
      pushedIds.add(t.id);
      const removedAt = overlay.removed[t.id];
      if (removedAt !== undefined && now - removedAt <= REMOVE_OVERLAY_TTL_MS) continue;
      const row = pushRowOf(t, machineId, p.machineName);
      const ren = overlay.renames[t.id];
      if (ren && now - ren.at <= RENAME_OVERLAY_TTL_MS) {
        rows.push({ ...row, title: ren.title, manual: true });
      } else {
        rows.push(row);
      }
    }
  }
  const created = overlay.created.filter(
    (c) => pushes[c.machineId] && !pushedIds.has(c.id) && now - c.createdAt <= CREATE_OVERLAY_TTL_MS,
  );
  const legacy = kv.filter((t) => !pushes[t.machineId]);
  return [...created, ...rows, ...legacy];
}

/**
 * Drop overlay entries the latest pushes have confirmed (or that expired):
 *   - created: id appeared in a push, or TTL passed, or its machine fell back
 *     to the legacy path (the KV record — if any — takes over there);
 *   - renames: the pushed title caught up, or TTL passed, or the terminal is
 *     gone from the pushes;
 *   - removed: the id vanished from the pushes (kill confirmed) or TTL passed.
 * Returns the SAME object when nothing changed, so callers can cheap-compare.
 */
export function pruneOverlay(
  overlay: PushOverlay,
  pushes: Record<string, MachinePush>,
  now: number,
): PushOverlay {
  const byId = new Map<string, MachineTerminal>();
  for (const p of Object.values(pushes)) {
    for (const t of p.terminals) byId.set(t.id, t);
  }

  const created = overlay.created.filter(
    (c) => pushes[c.machineId] && !byId.has(c.id) && now - c.createdAt <= CREATE_OVERLAY_TTL_MS,
  );

  const renames: PushOverlay['renames'] = {};
  for (const [id, r] of Object.entries(overlay.renames)) {
    const pushed = byId.get(id);
    if (!pushed) continue; // terminal gone → nothing left to rename
    if ((pushed.title ?? '').trim() === r.title) continue; // daemon caught up
    if (now - r.at > RENAME_OVERLAY_TTL_MS) continue; // never landed → honest revert
    renames[id] = r;
  }

  const removed: PushOverlay['removed'] = {};
  for (const [id, at] of Object.entries(overlay.removed)) {
    if (!byId.has(id)) continue; // absence confirmed → overlay done
    if (now - at > REMOVE_OVERLAY_TTL_MS) continue; // kill never landed → row returns
    removed[id] = at;
  }

  const unchanged =
    created.length === overlay.created.length &&
    created.every((c, i) => c === overlay.created[i]) &&
    Object.keys(renames).length === Object.keys(overlay.renames).length &&
    Object.keys(removed).length === Object.keys(overlay.removed).length;
  return unchanged ? overlay : { created, renames, removed };
}
