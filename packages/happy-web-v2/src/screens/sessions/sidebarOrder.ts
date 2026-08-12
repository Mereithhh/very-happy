/**
 * Pure ordering helpers for the sidebar's FULL manual order. No react /
 * storage imports so the semantics stay unit-testable (sidebarOrder.test.ts).
 *
 * Truth model: the synced settings field `sidebarOrder` maps a row key (chat
 * session id, or `t:<terminalId>` for a web terminal) to a lexicographic
 * fractional order key (boardTaskOps.orderKeyBetween — reused, not copied).
 * Keyed rows render sorted by their order strings; rows WITHOUT an entry are
 * new arrivals and render ON TOP, newest createdAt first, until the user
 * drags them (any drop materializes every visible unkeyed row in place).
 *
 * An EMPTY `sidebarOrder` means manual ordering hasn't been materialized yet:
 * the sidebar keeps the legacy display (pinnedRows section + activity order),
 * and the FIRST drag materializes that whole visible sequence into keys —
 * legacy pinned rows keep their top positions via mergeLegacyPinned. After
 * materialization `pinnedRows` is never written again (kept in the schema for
 * old clients, same treatment as the lastUsed* legacy fields).
 *
 * Concurrency: settings merge FIELD-level (last write wins per field), so two
 * devices dragging concurrently overwrite each other's whole table — accepted
 * trade-off for a low-frequency single-user gesture; see the settings schema
 * comment. Fractional keys still buy stable single-entry updates and the
 * unkeyed-on-top semantics.
 */
import { orderKeyBetween } from '@/sync/boardTaskOps';

export interface SidebarOrderEntry {
  key: string;
  order: string;
}

/** order-string comparison with a row-key tiebreak so the sort stays total
 *  (two devices materializing into the same gap render identically). */
function cmpOrder(aOrder: string, bOrder: string, aKey: string, bKey: string): number {
  if (aOrder !== bOrder) return aOrder < bOrder ? -1 : 1;
  return aKey.localeCompare(bKey);
}

/** Display order under the manual model: unkeyed rows first (newest createdAt
 *  first — new sessions/terminals surface at the top until dragged), then
 *  keyed rows by their order strings. */
export function sortRowsByManualOrder<T extends { key: string; createdAt: number }>(
  rows: T[],
  entries: SidebarOrderEntry[],
): T[] {
  const orderByKey = new Map(entries.map((e) => [e.key, e.order]));
  const fresh: T[] = [];
  const keyed: T[] = [];
  for (const r of rows) (orderByKey.has(r.key) ? keyed : fresh).push(r);
  fresh.sort((a, b) => (b.createdAt - a.createdAt) || a.key.localeCompare(b.key));
  keyed.sort((a, b) => cmpOrder(orderByKey.get(a.key)!, orderByKey.get(b.key)!, a.key, b.key));
  return [...fresh, ...keyed];
}

/**
 * First-drag migration input: merge the legacy `pinnedRows` keys into the
 * visible sequence. Visible pinned keys are already IN `seq` (the legacy
 * display puts them on top) and stay where the drag left them; pinned keys
 * with no visible row right now (e.g. terminals of a machine that isn't
 * loaded) are inserted right after the previous pinned key's position, so a
 * one-time materialization never silently drops a pin another device can
 * still see.
 */
export function mergeLegacyPinned(seq: string[], legacyPinned: string[]): string[] {
  const inSeq = new Set(seq);
  const out = [...seq];
  const seen = new Set<string>();
  let anchor = -1; // index in `out` of the last pinned key placed/found
  for (const k of legacyPinned) {
    if (seen.has(k)) continue; // defensive: dedupe corrupt lists
    seen.add(k);
    if (inSeq.has(k)) {
      anchor = out.indexOf(k);
      continue;
    }
    out.splice(anchor + 1, 0, k);
    anchor += 1;
  }
  return out;
}

/**
 * Order writes so that the manual sort renders exactly `seq` (the final
 * visible sequence after a drop / menu move). Minimal in the common case:
 * when every other visible row already carries a strictly increasing key,
 * only the moved row (and any unkeyed rows, materialized in place) get new
 * keys. If the kept keys aren't strictly increasing (corrupt / concurrent
 * same-gap writes) the whole visible sequence is re-keyed. Entries whose
 * rows aren't visible right now (unloaded machines) are carried untouched —
 * their keys still interleave correctly when the rows come back.
 *
 * Returns the SAME array when nothing changes, so callers can skip a
 * settings write on a no-op drop.
 */
export function planSidebarOrder(
  entries: SidebarOrderEntry[],
  seq: string[],
  movedKey?: string,
): SidebarOrderEntry[] {
  const orderByKey = new Map(entries.map((e) => [e.key, e.order]));

  // No-op guard: fully keyed and already rendering in exactly this order.
  if (entries.length > 0 && seq.every((k) => orderByKey.has(k))) {
    const sorted = [...seq].sort((a, b) =>
      cmpOrder(orderByKey.get(a)!, orderByKey.get(b)!, a, b),
    );
    if (seq.every((k, i) => k === sorted[i])) return entries;
  }

  // keys we intend to keep (not the moved row, already keyed)
  const kept: Array<string | undefined> = seq.map((k) =>
    k !== movedKey ? orderByKey.get(k) : undefined,
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
  if (!monotonic) kept.fill(undefined); // full re-key of the visible sequence

  // nextKept[i] = nearest kept key at or after i (upper bound for new keys)
  const nextKept: Array<string | null> = new Array(seq.length);
  let upcoming: string | null = null;
  for (let i = seq.length - 1; i >= 0; i--) {
    nextKept[i] = kept[i] !== undefined ? null : upcoming;
    if (kept[i] !== undefined) upcoming = kept[i]!;
  }

  const out: SidebarOrderEntry[] = [];
  let last: string | null = null;
  for (let i = 0; i < seq.length; i++) {
    if (kept[i] !== undefined) {
      last = kept[i]!;
      out.push({ key: seq[i], order: last });
      continue;
    }
    const order = orderKeyBetween(last, nextKept[i]);
    out.push({ key: seq[i], order });
    last = order;
  }

  // carry invisible entries untouched, in their original relative order
  const emitted = new Set(seq);
  for (const e of entries) {
    if (emitted.has(e.key)) continue;
    emitted.add(e.key); // also dedupes corrupt duplicate entries
    out.push(e);
  }

  if (
    out.length === entries.length &&
    out.every((e, i) => e.key === entries[i].key && e.order === entries[i].order)
  ) {
    return entries;
  }
  return out;
}

/** Move `key` to the very top of the KEYED order (used by the board card's
 *  "move to top of sidebar"). New unkeyed rows still render above — that top
 *  zone is transient by design. Same-array return = nothing to write. */
export function moveEntryToTop(entries: SidebarOrderEntry[], key: string): SidebarOrderEntry[] {
  if (entries.length === 0) return entries; // unmaterialized — caller handles legacy
  const others = entries.filter((e) => e.key !== key);
  const existing = entries.find((e) => e.key === key);
  if (others.length === 0) {
    return existing ? entries : [...entries, { key, order: orderKeyBetween(null, null) }];
  }
  const minOther = others.reduce((m, e) => (e.order < m ? e.order : m), others[0].order);
  if (existing && existing.order < minOther) return entries; // already strictly on top
  return [{ key, order: orderKeyBetween(null, minOther) }, ...others];
}

/** Drop entries whose row no longer exists (deleted / archived sessions, dead
 *  terminals). Returns null when nothing changed, so callers only write
 *  settings back on a real prune. Shared by the manual order and the legacy
 *  pinnedRows sweep. */
export function pruneEntries<T extends { key: string }>(
  list: T[],
  validKeys: ReadonlySet<string>,
): T[] | null {
  const next = list.filter((e) => validKeys.has(e.key));
  return next.length === list.length ? null : next;
}
