/**
 * Pure list operations for the board-task registry (Task Board V2). No
 * zustand / auth / network imports so the merge semantics stay unit-testable
 * (boardTaskOps.test.ts).
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
  /** lane position: lexicographic fractional key (orderKeyBetween). Absent on
   *  legacy tasks — they sort after keyed ones, newest first. */
  order?: string;
  /** when `order` was last set — merged INDEPENDENTLY of updatedAt so a drag
   *  on device A never clobbers (or is clobbered by) a rename on device B. */
  orderAt?: number;
}

/** How long a deletion tombstone survives before merge physically drops it. */
export const TASK_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

//
// Lane ordering — lexicographic fractional keys.
//
// Keys are plain strings compared with `<`; inserting between two keys never
// renumbers the rest of the list (a drag mutates exactly one task), so two
// devices dragging DIFFERENT tasks concurrently merge without conflict —
// each side's write only touches its own task's `order`/`orderAt`.
//

/** Base-62 digits in ASCII order — lexicographic string compare == numeric
 *  compare of the fraction the key encodes. */
const ORDER_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Midpoint of the open interval (a, b) as a digit string; `a` may be ''
 *  (-inf), `b` may be null (+inf). Never returns a key with a trailing
 *  minimum digit ('0'), so every generated key keeps room below it. */
function orderMidpoint(a: string, b: string | null): string {
  if (b !== null) {
    // strip the longest common prefix, padding `a` with virtual zeros
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + orderMidpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? ORDER_DIGITS.indexOf(a[0]) : 0;
  const digitB = b !== null ? ORDER_DIGITS.indexOf(b[0]) : ORDER_DIGITS.length;
  if (digitB - digitA > 1) {
    return ORDER_DIGITS[Math.round(0.5 * (digitA + digitB))];
  }
  // consecutive leading digits
  if (b !== null && b.length > 1) {
    // b's own first digit is already strictly between (a…, b…)
    return b.slice(0, 1);
  }
  // recurse: keep a's digit, find something after a's tail
  return ORDER_DIGITS[digitA] + orderMidpoint(a.slice(1), null);
}

/** A key strictly between `a` and `b` (null = open end). Throws if a >= b —
 *  callers pass neighbors from an already-sorted list. */
export function orderKeyBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) {
    throw new Error(`orderKeyBetween: "${a}" >= "${b}"`);
  }
  return orderMidpoint(a ?? '', b);
}

/** Board display order: keyed tasks first (lexicographic), legacy unkeyed
 *  tasks after them newest-first (the pre-order behavior). Id tiebreak keeps
 *  the sort total, so equal keys (two devices inserting into the same gap)
 *  render identically on every device. */
export function compareTaskOrder(a: BoardTask, b: BoardTask): number {
  if (a.order != null && b.order != null) {
    if (a.order !== b.order) return a.order < b.order ? -1 : 1;
    return a.id.localeCompare(b.id);
  }
  if (a.order != null) return -1;
  if (b.order != null) return 1;
  const d = (b.createdAt ?? 0) - (a.createdAt ?? 0);
  return d !== 0 ? d : a.id.localeCompare(b.id);
}

/**
 * Order writes needed so that lexicographic `order` matches `seq` (the final
 * display sequence after a drag / move). Minimal in the common case: when
 * every other task already carries a strictly increasing key, only the moved
 * task gets a new key (single-task write → cross-device merge can't clobber
 * anyone else). Tasks without keys (legacy) are materialized in place; if the
 * kept keys aren't strictly increasing (corrupt / concurrent same-gap
 * inserts), every task is re-keyed in sequence order.
 */
export function planOrderWrites(
  seq: BoardTask[],
  movedId?: string,
): Array<{ id: string; order: string }> {
  // keys we intend to keep (not moved, already keyed)
  const kept: Array<string | undefined> = seq.map((t) =>
    t.id !== movedId && t.order != null ? t.order : undefined,
  );
  let monotonic = true;
  let prev: string | undefined;
  for (const k of kept) {
    if (k === undefined) continue;
    if (prev !== undefined && k <= prev) {
      monotonic = false;
      break;
    }
    prev = k;
  }
  if (!monotonic) kept.fill(undefined); // full re-key

  // nextKept[i] = nearest kept key at or after i (upper bound for new keys)
  const nextKept: Array<string | null> = new Array(seq.length);
  let upcoming: string | null = null;
  for (let i = seq.length - 1; i >= 0; i--) {
    nextKept[i] = kept[i] !== undefined ? null : upcoming;
    if (kept[i] !== undefined) upcoming = kept[i]!;
  }

  const writes: Array<{ id: string; order: string }> = [];
  let last: string | null = null;
  for (let i = 0; i < seq.length; i++) {
    if (kept[i] !== undefined) {
      last = kept[i]!;
      continue;
    }
    const key = orderKeyBetween(last, nextKept[i]);
    // skip a no-op write (task already carries exactly this key)
    if (seq[i].order !== key) writes.push({ id: seq[i].id, order: key });
    last = key;
  }
  return writes;
}

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
 *  id the newer `updatedAt` wins, `sessionIds` are unioned, `order` follows
 *  its own `orderAt` clock (a drag and a rename of the same task on two
 *  devices are independent mutations — both must survive), remote-only tasks
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
    // order rides its own timestamp; on a tie the side that HAS a key wins
    // (local first) — a keyed side must never be erased by an unkeyed one
    const orderSrc =
      (r.orderAt ?? 0) > (l.orderAt ?? 0) ? r
      : (l.orderAt ?? 0) > (r.orderAt ?? 0) ? l
      : l.order != null ? l : r;
    const out: BoardTask = { ...winner, sessionIds: unionSessionIds(l.sessionIds, r.sessionIds) };
    if (orderSrc.order != null) {
      out.order = orderSrc.order;
      out.orderAt = orderSrc.orderAt;
    } else {
      delete out.order;
      delete out.orderAt;
    }
    merged.push(out);
  }
  const remoteOnly = [...remoteById.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return [...remoteOnly, ...merged].filter(
    (t) => t.status !== 'deleted' || now - mutTs(t) <= TASK_TOMBSTONE_TTL_MS,
  );
}
