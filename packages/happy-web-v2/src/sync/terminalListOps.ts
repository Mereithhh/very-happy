/**
 * Pure list operations for the terminal-session registry. No zustand / auth /
 * network imports so the merge + reconcile semantics stay unit-testable.
 *
 * Truth model (title):
 * - The MACHINE owns a terminal's title (tmux session option `@vh_title`).
 *   Reconcile backfills machine titles into local records so a rename made on
 *   device A reaches device B within one poll cycle — with two exceptions:
 *   1. `pendingTitle` records (a local rename the machine hasn't acked yet,
 *      e.g. renamed while the machine was offline): the LOCAL title is newer
 *      than the machine's, so we push it out instead of backfilling.
 *   2. records mutated within `RECENT_MUTATION_MS`: a `list-terminals`
 *      snapshot in flight when the user renamed must not revert the fresh
 *      value; the next poll (10s) already carries the new title.
 *
 * Truth model (list membership): unchanged — the machine's live tmux `vh-*`
 * set decides which records exist (adopt orphans, reap dead ones).
 *
 * KV blob (`vh.terminal-sessions`, ONE key for the whole list): merged
 * per-terminal by `updatedAt` instead of last-write-wins on the blob, so two
 * devices editing different terminals no longer clobber each other. Deletions
 * carry no tombstones: a record deleted on one device can be resurrected by
 * the merge, but the machine reconcile reaps it on the next poll because its
 * tmux session is gone (kill-terminal killed it before the record was removed).
 */

export interface TerminalSession {
  id: string; // tmux session = vh-<id>, also the relay terminalId
  machineId: string;
  machineName: string;
  title: string;
  manual?: boolean; // user renamed it → never auto-title again
  createdAt: number;
  /** Last record mutation (local or backfilled) — drives the per-terminal KV merge. */
  updatedAt?: number;
  /** Local rename not yet confirmed on the machine (@vh_title) — push, don't backfill. */
  pendingTitle?: boolean;
}

export interface LiveTerminal {
  id: string;
  title?: string;
  createdAt?: number;
}

/** A just-created terminal's tmux may still be spawning. */
export const GRACE_MS = 30_000;
/** Ignore machine-title backfill for records mutated this recently (stale-snapshot race). */
export const RECENT_MUTATION_MS = 15_000;

function mutTs(t: TerminalSession): number {
  return t.updatedAt ?? t.createdAt ?? 0;
}

export interface ReconcileResult {
  next: TerminalSession[];
  /** Local titles the machine doesn't have yet → caller should write @vh_title. */
  pushTitles: Array<{ id: string; machineId: string; title: string }>;
  changed: boolean;
}

/** Reconcile our records against a machine's REAL live tmux `vh-*` sessions:
 *  adopt orphans, reap dead records, and sync titles both ways (see header). */
export function reconcileWithMachine(
  cur: TerminalSession[],
  machineId: string,
  machineName: string,
  live: LiveTerminal[],
  now: number,
): ReconcileResult {
  const liveById = new Map(live.map((l) => [l.id, l]));
  const pushTitles: ReconcileResult['pushTitles'] = [];
  // Drop dead records for THIS machine (in our list, gone on the machine),
  // sparing very recent ones so a new-terminal/list race can't reap them.
  let next = cur.filter(
    (t) => t.machineId !== machineId || liveById.has(t.id) || now - (t.createdAt ?? 0) < GRACE_MS,
  );
  // Title sync for records the machine knows about.
  next = next.map((t) => {
    if (t.machineId !== machineId) return t;
    const l = liveById.get(t.id);
    if (!l) return t;
    const liveTitle = (l.title ?? '').trim();
    if (t.pendingTitle) {
      if (liveTitle === t.title) {
        // Machine caught up with our rename → pending resolved.
        return { ...t, pendingTitle: undefined, updatedAt: now };
      }
      // Machine is behind (rename RPC failed / machine was offline) → push our
      // title out; never backfill the stale machine value over a pending rename.
      pushTitles.push({ id: t.id, machineId, title: t.title });
      return t;
    }
    if (liveTitle && liveTitle !== t.title && now - mutTs(t) > RECENT_MUTATION_MS) {
      // Machine title is the cross-device truth → backfill it. `manual` because
      // a set @vh_title means someone titled it (rename or first-command auto);
      // local auto-titling must not fight it.
      return { ...t, title: liveTitle, manual: true, updatedAt: now };
    }
    if (!liveTitle && t.manual) {
      // Legacy manual rename that never reached the machine (pre-fix records):
      // heal by pushing it out. Idempotent — stops firing once @vh_title is set.
      pushTitles.push({ id: t.id, machineId, title: t.title });
    }
    return t;
  });
  // Adopt orphans present on the machine but missing from our list — so
  // sessions created on other devices / older clients (or whose record was
  // lost) become visible and manageable here instead of leaking.
  const known = new Set(next.filter((t) => t.machineId === machineId).map((t) => t.id));
  const adopted: TerminalSession[] = live
    .filter((l) => !known.has(l.id))
    .map((l) => ({
      id: l.id,
      machineId,
      machineName,
      title: (l.title ?? '').trim() || machineName || 'Terminal',
      manual: !!(l.title ?? '').trim(),
      createdAt: l.createdAt ?? now,
      updatedAt: now,
    }));
  if (adopted.length) next = [...adopted, ...next];
  const changed = !(next.length === cur.length && next.every((t, i) => t === cur[i]));
  return { next, pushTitles, changed };
}

/** Merge two versions of the list per-terminal (newer `updatedAt` wins per id;
 *  union of ids). Used both on KV version conflicts (another device wrote) and
 *  at initialize (server copy vs local cache). */
export function mergeTerminalLists(
  local: TerminalSession[],
  remote: TerminalSession[],
): TerminalSession[] {
  const remoteById = new Map(remote.map((r) => [r.id, r]));
  const merged = local.map((l) => {
    const r = remoteById.get(l.id);
    if (!r) return l;
    remoteById.delete(l.id);
    return mutTs(r) > mutTs(l) ? r : l;
  });
  if (remoteById.size === 0) return merged;
  const remoteOnly = [...remoteById.values()].sort(
    (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
  );
  return [...remoteOnly, ...merged];
}
