/**
 * B-947: the sidebar's order is fixed for one page load.
 *
 * Owner (11-21): with many projects open, any background session that printed
 * or got a message moved its project group, so the sidebar kept reshuffling
 * while being used. The order is now decided ONCE — on the first render after
 * a (re)load, by most recent activity — and afterwards nothing that happens in
 * the background moves an existing row or group:
 *
 *   • rows (sessions / terminals) keep their snapshot sequence; content,
 *     status dots, unread and running markers still update live;
 *   • a row that appears later goes where its activity puts it against the
 *     FROZEN snapshot values — a brand-new session is newer than everything,
 *     so it lands on top (of its project group, once grouped); an old
 *     terminal whose machine reported late lands in its activity slot;
 *   • a group (project / folder) that appears later goes on top; existing
 *     groups never move;
 *   • reload, or the menu's 「按最近活动重新排序」, starts a fresh snapshot.
 *
 * Keys that disappear stay in the snapshot, so a row that blinks out and back
 * (machine reconnect, archive → unarchive) returns to its old place instead of
 * jumping to the top. Everything is pure and idempotent (same input → same
 * state and output), so React re-running a memo is harmless.
 */

export interface FrozenRowOrder {
  /** row keys in display order */
  keys: string[];
  /** the activity value each key was placed with (never refreshed) */
  ts: Map<string, number>;
}

/** Most recently active first, key tiebreak (same comparator as sortRowsByRecent). */
function byRecent<T extends { key: string; ts: number }>(a: T, b: T): number {
  return (b.ts - a.ts) || a.key.localeCompare(b.key);
}

/**
 * Order `rows` by the frozen sequence, extending it with rows it hasn't seen.
 * `prev === null` takes the snapshot: plain most-recent-first.
 * Returns the (possibly unchanged) state and the ordered rows.
 */
export function stabilizeRowOrder<T extends { key: string; ts: number }>(
  prev: FrozenRowOrder | null,
  rows: readonly T[],
): { state: FrozenRowOrder; rows: T[] } {
  if (!prev) {
    const sorted = [...rows].sort(byRecent);
    return { state: { keys: sorted.map((r) => r.key), ts: new Map(sorted.map((r) => [r.key, r.ts])) }, rows: sorted };
  }
  const fresh = rows.filter((r) => !prev.ts.has(r.key)).sort(byRecent);
  let state = prev;
  if (fresh.length > 0) {
    // Merge the fresh rows (newest first) into the frozen sequence by activity:
    // each one goes before the first frozen key it is newer than.
    const keys: string[] = [];
    let i = 0;
    for (const k of prev.keys) {
      const kts = prev.ts.get(k)!;
      while (i < fresh.length && (fresh[i].ts > kts || (fresh[i].ts === kts && fresh[i].key < k))) keys.push(fresh[i++].key);
      keys.push(k);
    }
    while (i < fresh.length) keys.push(fresh[i++].key);
    const ts = new Map(prev.ts);
    for (const r of fresh) ts.set(r.key, r.ts);
    state = { keys, ts };
  }
  const rank = new Map(state.keys.map((k, i) => [k, i]));
  return { state, rows: [...rows].sort((a, b) => rank.get(a.key)! - rank.get(b.key)!) };
}

/**
 * Order `groups` by the frozen group sequence. `prev === null` takes the
 * snapshot: the groups' current order (callers hand them in most-recent-first).
 * Groups not in the snapshot go on top, in their incoming order.
 */
export function stabilizeGroupOrder<G>(
  prev: readonly string[] | null,
  groups: readonly G[],
  idOf: (g: G) => string,
): { state: string[]; groups: G[] } {
  if (!prev) return { state: groups.map(idOf), groups: [...groups] };
  const known = new Set(prev);
  const fresh = groups.filter((g) => !known.has(idOf(g)));
  const state = fresh.length > 0 ? [...fresh.map(idOf), ...prev] : [...prev];
  const rank = new Map(state.map((id, i) => [id, i]));
  return { state, groups: [...groups].sort((a, b) => rank.get(idOf(a))! - rank.get(idOf(b))!) };
}

/** Snapshot order for project groups: most recent activity first, id tiebreak. */
export function sortGroupsByRecent<G extends { id: string; lastActivity: number }>(groups: readonly G[]): G[] {
  return [...groups].sort((a, b) => (b.lastActivity - a.lastActivity) || a.id.localeCompare(b.id));
}

/**
 * Loading is not one instant: the session list lands with the first sync
 * (Sidebar renders no rows before `isDataReady`), the project list when its
 * fetch resolves (no group snapshot before `status === 'ready'`), but web
 * terminals come with the machines' state, which can trail by a few hundred
 * ms. Freezing on the very first data would rank a project whose activity is
 * only in its terminals too low, and push folder groups that arrive late to
 * the top. So the snapshot keeps being RE-TAKEN for `LOAD_SETTLE_MS` after the
 * data first became ready, and only then freezes.
 */
export const LOAD_SETTLE_MS = 2500;

/** The previous state to extend, or null (= take a fresh snapshot) while the load is still settling. */
export function settledPrev<S>(prev: S | null, readyAt: number | null, now: number, settleMs = LOAD_SETTLE_MS): S | null {
  if (readyAt === null) return null;
  return now - readyAt < settleMs ? null : prev;
}
