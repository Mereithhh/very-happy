/**
 * Pure operations for the daemon-pushed terminal list. No zustand / network
 * imports so every rule here is unit-testable.
 *
 * Truth model: the daemon tracks its own tmux `vh-*` list (membership,
 * titles, agent states, activity) and writes each CHANGE into
 * `daemonState.webTerminals`. The server persists daemonState and broadcasts
 * `update-machine`, so:
 *   - online machines: the push IS the list — no polling, no client-side
 *     reconciliation, deletion propagates by absence (no tombstones);
 *   - offline machines: the server's persisted daemonState still carries the
 *     last list — display works with zero client-side storage.
 *
 * Ownership rule (B-360): terminal ids are unique per HOST, not per machine
 * row, and one host can own several rows — so the same id can arrive in two
 * machines' pushes. The newest snapshot owns it; see `terminalOwnerByMachine`.
 *
 * This is the ONLY lane since the legacy poll+KV path was retired (2026-08):
 * the web requires a push-capable daemon (>= 0.2.27). A machine whose daemon
 * predates that simply shows no terminals (see the trust rule below).
 *
 * Trust rule (feature detection + downgrade safety): the snapshot counts only
 * when `updatedAt >= startedAt`, i.e. it was written by the CURRENT daemon
 * run. New daemons stamp both with the same clock reading in their connect
 * write, so trust never flaps across reconnects. A daemon DOWNGRADED to a
 * pre-push version spreads the stale field forward (`{...state}`) but bumps
 * `startedAt` without restamping — the rule fails and the machine's terminals
 * are not rendered (stale data must not masquerade as live).
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
 *     or the TTL expires (kill never landed — the row honestly returns, so a
 *     failed kill can never hide a live terminal forever).
 */
import type { MachineTerminal } from '@/sync/ops';

/** One rendered terminal row (derived from a push or the optimistic overlay). */
export interface TerminalSession {
  id: string; // tmux session = vh-<id>, also the relay terminalId
  machineId: string;
  machineName: string;
  title: string;
  /** undefined = old daemon without tag support; [] = supported, no tags. */
  tags?: string[];
  /** Titled (manual rename or daemon auto-title): the pushed @vh_title set. */
  manual?: boolean;
  /** Pushed tmux pane cwd — the file browser's starting directory. */
  cwd?: string;
  createdAt: number;
  /** Last known activity (pushed tmux session_activity, or creation). */
  updatedAt?: number;
  /** B-105: shadow mirror session id, when the daemon is mirroring a
   *  hand-launched `claude` in this terminal (drives the structured toggle). */
  mirrorSessionId?: string;
  /** B-150: auto-restored after a restart — badged until opened once. */
  restoredAt?: number;
  /** B-273: this terminal is attached to the user's tmux session of this name
   *  (close = detach only; B-282 offers kill-together separately). */
  attachTmux?: string;
}

/** A trusted webTerminals snapshot read out of a machine's daemonState. */
export interface PushedSnapshot {
  updatedAt: number;
  terminals: MachineTerminal[];
}

/** One machine's applied push, as held by the terminalSessions store. */
export interface MachinePush {
  machineName: string;
  terminals: MachineTerminal[];
  /** `webTerminals.updatedAt` of the snapshot this push came from — the
   *  tiebreaker when two machine rows claim the same terminal id (B-360). */
  updatedAt: number;
}

export interface PushOverlay {
  /** Optimistic rows for terminals created locally, keyed into pushes by id. */
  created: TerminalSession[];
  /** id → optimistic metadata changes the daemon hasn't pushed back yet. */
  renames: Record<string, { title?: string; tags?: string[]; at: number }>;
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
 * machine has none (old daemon, downgraded daemon, malformed state). See the
 * module header for the trust rule. Tolerant of any daemonState shape (it's
 * untyped JSON from the wire): malformed items are dropped, a malformed
 * container is null.
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

/** Every machine's trusted snapshot, for the sync loop. Machines without one
 *  (old/downgraded daemons) are simply absent — nothing is rendered for them. */
export function pushedMachineSnapshots(
  machines: Array<{ id: string; daemonState: any }>,
): Array<{ id: string; snapshot: PushedSnapshot }> {
  const pushed: Array<{ id: string; snapshot: PushedSnapshot }> = [];
  for (const m of machines) {
    const snapshot = trustedWebTerminals(m.daemonState);
    if (snapshot) pushed.push({ id: m.id, snapshot });
  }
  return pushed;
}

/** Map one pushed terminal into the store's row shape. An empty daemon title
 *  falls back to the machine name; a set title marks the row `manual`. */
function pushRowOf(t: MachineTerminal, machineId: string, machineName: string): TerminalSession {
  const title = (t.title ?? '').trim();
  const tags = Array.isArray(t.tags)
    ? t.tags.filter((tag): tag is string => typeof tag === 'string')
    : undefined;
  return {
    id: t.id,
    machineId,
    machineName,
    title: title || machineName || 'Terminal',
    tags,
    manual: !!title,
    cwd: t.cwd,
    createdAt: t.createdAt ?? 0,
    updatedAt: t.activityAt ?? t.createdAt,
    // Off the wire from a daemon of unknown version — accept strings only.
    mirrorSessionId:
      typeof t.mirrorSessionId === 'string' && t.mirrorSessionId ? t.mirrorSessionId : undefined,
    restoredAt: typeof t.restoredAt === 'number' && t.restoredAt > 0 ? t.restoredAt : undefined,
    attachTmux: typeof t.attachTmux === 'string' && t.attachTmux ? t.attachTmux : undefined,
  };
}

/**
 * Which machine owns each pushed terminal id (B-360).
 *
 * A terminal id is a tmux session name (`vh-<id>`) — unique on its HOST, not
 * across machine rows. And a host can hold more than one machine row: the id
 * is a randomUUID in `~/.happy/settings.json`, so anything that loses or
 * rotates that file (the 0.2.118→0.2.119 auto-update handover did, 2026-09-04)
 * leaves the old row behind with its last daemonState — which this app renders
 * on purpose, because that is how OFFLINE machines still show their terminals.
 * Two rows for one host therefore push the SAME ids, and the composer used to
 * emit a row per (machine, terminal) pair: every terminal on that host appeared
 * twice, on every device, with no way for the user to make it stop.
 *
 * The invariant this restores: one rendered row per terminal id. The owner is
 * the machine whose snapshot is NEWEST — the live daemon rewrites
 * `webTerminals` (its connect write alone is later than anything the retired
 * daemon ever wrote), while an abandoned row is frozen forever. Ties break on
 * machine id so the choice is deterministic. Machines that do NOT share a host
 * never collide (ids are random), so this costs them nothing.
 */
export function terminalOwnerByMachine(pushes: Record<string, MachinePush>): Map<string, string> {
  const owner = new Map<string, string>();
  const ownerUpdatedAt = new Map<string, number>();
  for (const machineId of Object.keys(pushes).sort()) {
    const p = pushes[machineId];
    const updatedAt = p.updatedAt ?? 0;
    for (const t of p.terminals) {
      const held = ownerUpdatedAt.get(t.id);
      if (held !== undefined && held >= updatedAt) continue;
      owner.set(t.id, machineId);
      ownerUpdatedAt.set(t.id, updatedAt);
    }
  }
  return owner;
}

/**
 * Compose the single list consumers render:
 *   1. optimistic creations (newest, prepended — a just-created terminal shows
 *      immediately even before its machine's first push arrives),
 *   2. pushed rows per machine (created-desc, machines in stable id order),
 *      with rename/remove overlays applied, one row per terminal id.
 */
export function composeTerminalList(
  pushes: Record<string, MachinePush>,
  overlay: PushOverlay,
  now: number,
): TerminalSession[] {
  const rows: TerminalSession[] = [];
  const pushedIds = new Set<string>();
  const owner = terminalOwnerByMachine(pushes);
  for (const machineId of Object.keys(pushes).sort()) {
    const p = pushes[machineId];
    const sorted = [...p.terminals].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    for (const t of sorted) {
      pushedIds.add(t.id);
      // Another machine row claims this id with a fresher snapshot — the
      // terminal is rendered there, not twice.
      if (owner.get(t.id) !== machineId) continue;
      const removedAt = overlay.removed[t.id];
      if (removedAt !== undefined && now - removedAt <= REMOVE_OVERLAY_TTL_MS) continue;
      const row = pushRowOf(t, machineId, p.machineName);
      const ren = overlay.renames[t.id];
      if (ren && now - ren.at <= RENAME_OVERLAY_TTL_MS) {
        rows.push({
          ...row,
          ...(ren.title !== undefined ? { title: ren.title, manual: true } : {}),
          ...(ren.tags !== undefined ? { tags: ren.tags } : {}),
        });
      } else {
        rows.push(row);
      }
    }
  }
  const created = overlay.created.filter(
    (c) => !pushedIds.has(c.id) && now - c.createdAt <= CREATE_OVERLAY_TTL_MS,
  );
  return [...created, ...rows];
}

/**
 * Drop overlay entries the latest pushes have confirmed (or that expired):
 *   - created: id appeared in a push, or TTL passed;
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
    (c) => !byId.has(c.id) && now - c.createdAt <= CREATE_OVERLAY_TTL_MS,
  );

  const renames: PushOverlay['renames'] = {};
  for (const [id, r] of Object.entries(overlay.renames)) {
    const pushed = byId.get(id);
    if (!pushed) continue; // terminal gone → nothing left to rename
    const titleDone = r.title === undefined || (pushed.title ?? '').trim() === r.title;
    const tagsDone = r.tags === undefined || JSON.stringify(pushed.tags) === JSON.stringify(r.tags);
    if (titleDone && tagsDone) continue; // daemon caught up
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
