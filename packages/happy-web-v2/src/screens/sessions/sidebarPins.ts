/**
 * LEGACY pinned-rows helpers — the pre-materialization sidebar model.
 *
 * The synced settings field `pinnedRows` (ordered array of `{ key }`) is
 * superseded by the full manual order in `sidebarOrder` (sidebarOrder.ts).
 * These helpers only serve the transition window while `sidebarOrder` is
 * still empty: `splitPinnedRows` renders the legacy pinned-on-top display,
 * and `upsertPinAt` lets the board card's "move to top" keep writing the
 * legacy field until the first drag materializes everything. Once
 * `sidebarOrder` is non-empty, `pinnedRows` is never written again.
 *
 * No react / storage imports so the semantics stay unit-testable.
 */

export interface PinnedRow {
  key: string;
}

/** Split rows into (pinned in pin-array order, rest in original order).
 *  Pinned keys with no matching row (deleted / archived / filtered out by the
 *  current search) are simply skipped — rendering never shows ghosts. */
export function splitPinnedRows<T extends { key: string }>(
  rows: T[],
  pinned: PinnedRow[],
): { pinned: T[]; rest: T[] } {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const pinnedKeys = new Set<string>();
  const pinnedRows: T[] = [];
  for (const p of pinned) {
    if (pinnedKeys.has(p.key)) continue; // defensive: dedupe corrupt lists
    const row = byKey.get(p.key);
    if (!row) continue;
    pinnedKeys.add(p.key);
    pinnedRows.push(row);
  }
  return { pinned: pinnedRows, rest: rows.filter((r) => !pinnedKeys.has(r.key)) };
}

/** Upsert-at-position: ensure `key` is pinned and sits at index `to`, where
 *  `to` is counted over the list WITH `key` removed. Unpinned keys are
 *  inserted, already-pinned keys are moved; out-of-range targets clamp.
 *  Returns the SAME array when the result is identical, so callers can skip
 *  a settings write on a no-op. */
export function upsertPinAt(pinned: PinnedRow[], key: string, to: number): PinnedRow[] {
  const without = pinned.filter((p) => p.key !== key);
  const clamped = Math.max(0, Math.min(without.length, to));
  const next = [...without.slice(0, clamped), { key }, ...without.slice(clamped)];
  if (next.length === pinned.length && next.every((p, i) => p.key === pinned[i].key)) {
    return pinned;
  }
  return next;
}
