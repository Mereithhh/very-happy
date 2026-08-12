/**
 * Pure list operations for the board-task registry (Task Board V2). No
 * zustand / auth / network imports so the merge semantics stay unit-testable
 * (boardTaskOps.test.ts) — same pattern as terminalListOps.ts.
 *
 * Truth model: KV `vh.board-tasks.v1` holds ONE blob for the whole list,
 * version-checked. On a conflict (another device wrote first) the two lists
 * are merged PER TASK by `updatedAt` (newer mutation wins), not blob-level
 * last-write-wins — two devices editing different tasks must not clobber
 * each other.
 *
 * Deletion: a tombstone, not a removal. `status: 'deleted'` + a bumped
 * `updatedAt` is simply the newest mutation and wins the merge, so deletes
 * propagate across devices instead of being resurrected by a device that
 * still carries the pre-delete copy (the exact failure the terminal registry
 * hit before its deletedAt tombstones). Renderers must go through
 * `visibleTasks()`. Tombstones older than TASK_TOMBSTONE_TTL_MS are
 * physically dropped at merge time — by then every device that was online
 * within the TTL has merged against the deletion.
 *
 * `sessionIds` (the manual task→session dispatch mapping) is UNIONED across
 * both sides rather than taken from the per-task winner: a dispatch on
 * device A and a rename on device B are independent mutations, and dispatch
 * mappings only ever grow — union loses nothing and drops neither edit.
 */

export interface BoardTask {
  id: string;
  title: string;
  description?: string;
  status: 'open' | 'done' | 'deleted';
  createdAt: number;
  /** last record mutation — drives the per-task KV merge */
  updatedAt?: number;
  /** sessions dispatched for this task (manual mapping; authoritative over
   *  the LLM's metadata.board.taskId fallback) */
  sessionIds?: string[];
}

/** How long a deletion tombstone survives before merge physically drops it. */
export const TASK_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function mutTs(t: BoardTask): number {
  return t.updatedAt ?? t.createdAt ?? 0;
}

/** The renderable subset: everything not tombstoned. */
export function visibleTasks(list: BoardTask[]): BoardTask[] {
  return list.filter((t) => t.status !== 'deleted');
}

function unionSessionIds(a?: string[], b?: string[]): string[] | undefined {
  if (!a?.length && !b?.length) return a ?? b;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...(a ?? []), ...(b ?? [])]) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Merge two versions of the task list (KV conflict / initialize): per task
 *  id the newer `updatedAt` wins, `sessionIds` are unioned, remote-only tasks
 *  are appended (newest first), and expired tombstones are dropped. */
export function mergeBoardTasks(
  local: BoardTask[],
  remote: BoardTask[],
  now: number = Date.now(),
): BoardTask[] {
  const remoteById = new Map(remote.map((r) => [r.id, r]));
  const merged: BoardTask[] = [];
  for (const l of local) {
    const r = remoteById.get(l.id);
    if (!r) {
      merged.push(l);
      continue;
    }
    remoteById.delete(l.id);
    const winner = mutTs(r) > mutTs(l) ? r : l;
    merged.push({ ...winner, sessionIds: unionSessionIds(l.sessionIds, r.sessionIds) });
  }
  const remoteOnly = [...remoteById.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return [...remoteOnly, ...merged].filter(
    (t) => t.status !== 'deleted' || now - mutTs(t) <= TASK_TOMBSTONE_TTL_MS,
  );
}
