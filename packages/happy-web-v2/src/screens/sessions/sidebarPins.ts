/**
 * Pure ordering helpers for the sidebar's pinned section. No react / storage
 * imports so the semantics stay unit-testable.
 *
 * The synced settings field `pinnedRows` is an ordered array of
 * `{ key }` — key is a chat session id, or `t:<terminalId>` for a web
 * terminal — and the ARRAY ORDER is the display order of the pinned section.
 * The unpinned remainder keeps whatever order the caller passed (activity
 * order in the sidebar).
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

export function isPinned(pinned: PinnedRow[], key: string): boolean {
  return pinned.some((p) => p.key === key);
}

/** Pin appends at the END of the pinned section; unpin removes. */
export function togglePin(pinned: PinnedRow[], key: string): PinnedRow[] {
  return isPinned(pinned, key)
    ? pinned.filter((p) => p.key !== key)
    : [...pinned, { key }];
}

/** Move a pinned key one step up (-1) or down (+1); no-op at the edges or
 *  for unknown keys. */
export function movePin(pinned: PinnedRow[], key: string, dir: -1 | 1): PinnedRow[] {
  const from = pinned.findIndex((p) => p.key === key);
  if (from < 0) return pinned;
  const to = from + dir;
  if (to < 0 || to >= pinned.length) return pinned;
  return reorderPin(pinned, from, to);
}

/** Drag-reorder: move the entry at `from` to position `to`. */
export function reorderPin(pinned: PinnedRow[], from: number, to: number): PinnedRow[] {
  if (from === to || from < 0 || from >= pinned.length) return pinned;
  const clamped = Math.max(0, Math.min(pinned.length - 1, to));
  if (clamped === from) return pinned;
  const next = [...pinned];
  const [moved] = next.splice(from, 1);
  next.splice(clamped, 0, moved);
  return next;
}

/** Drop pinned keys that are no longer valid (deleted sessions, archived
 *  sessions, dead terminals). Returns null when nothing changed, so callers
 *  only write settings back on a real prune. */
export function prunePinned(pinned: PinnedRow[], validKeys: ReadonlySet<string>): PinnedRow[] | null {
  const next = pinned.filter((p) => validKeys.has(p.key));
  return next.length === pinned.length ? null : next;
}
