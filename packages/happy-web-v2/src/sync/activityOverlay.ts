/**
 * activityOverlay — pure ops for the sidebar's REALTIME "last active" overlay.
 *
 * The sidebar sorts by a row's last-activity time. Its base value comes from
 * the slow, durable lanes (a chat session's `updatedAt`, a terminal's pushed
 * `activityAt` inside daemonState.webTerminals) — both correct, neither fast.
 * This module holds the two fast sources that ride on top of them:
 *
 *   • LOCAL (layer 1, activityOverlayStore.local) — "I just did this myself".
 *     Typing into a terminal, opening a terminal and focusing it, sending a
 *     chat message. The browser already knows the instant it happens, so
 *     there is nothing to wait for: zero network, zero protocol, works with
 *     any daemon and even offline. PER-DEVICE ON PURPOSE — "what I was just
 *     looking at" is a fact about THIS browser, not about the account. Two
 *     devices legitimately disagree, so this map is never synced.
 *
 *   • REMOTE (layer 2, activityOverlayStore.remote) — "that machine's
 *     terminal just printed something", delivered by the daemon's ephemeral
 *     `terminal-activity` frames (relayed, never persisted). This is what
 *     makes pure OUTPUT float a row within ~a second instead of waiting on
 *     the 60s activity bucket that protects the persisted daemonState lane.
 *
 * Both are advisory: they can only ever move a row UP, they never replace the
 * durable value, and losing them (reload with no persistence, dropped frame,
 * old daemon) degrades exactly to today's behaviour.
 *
 * Keys are the SIDEBAR ROW KEYS, one convention across both maps:
 *   terminal → `t:<terminalId>`   chat session → `<sessionId>`
 * (see activityKeyForTerminal / activityKeyForSession). No react, no storage,
 * no network imports — every rule below is unit-tested.
 */

/** rowKey → last-activity ms. */
export type ActivityMap = Readonly<Record<string, number>>;

export const EMPTY_ACTIVITY: ActivityMap = {};

/** Cap on stored LOCAL stamps. Way past any plausible number of sessions a
 *  person touches in a sitting; exists so a long-lived browser profile can't
 *  grow the map forever as sessions are created and deleted. */
export const LOCAL_ACTIVITY_CAP = 300;

/** Cap on in-memory REMOTE stamps (terminals across all machines). */
export const REMOTE_ACTIVITY_CAP = 500;

/** The sidebar row key for a web terminal — must match Sidebar's `t:${id}`. */
export function activityKeyForTerminal(terminalId: string): string {
  return `t:${terminalId}`;
}

/** The sidebar row key for a chat session — the bare session id. */
export function activityKeyForSession(sessionId: string): string {
  return sessionId;
}

/**
 * Apply `updates` to `map`, keeping the NEWER value per key (activity is
 * monotonic — a late-arriving frame or a tmux poll that reports an older
 * `#{session_activity}` than the pty already told us must never pull a row
 * back down). Non-finite / non-positive stamps are ignored.
 *
 * Returns the SAME object when nothing moved, so callers can skip the store
 * write and the re-render entirely — this is what keeps a chatty machine from
 * repainting the sidebar for updates that change nothing.
 */
export function mergeActivity(
  map: ActivityMap,
  updates: Readonly<Record<string, number>>,
  cap: number,
): ActivityMap {
  let next: Record<string, number> | null = null;
  for (const [key, at] of Object.entries(updates)) {
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) continue;
    if (at <= (map[key] ?? 0)) continue;
    if (!next) next = { ...map };
    next[key] = at;
  }
  if (!next) return map;
  return pruneActivity(next, cap);
}

/**
 * Keep the `cap` most recent entries. Ties break on key so the result is
 * deterministic across devices. Returns the SAME object when already within
 * the cap (the overwhelmingly common case — pruning is the rare path).
 */
export function pruneActivity(map: ActivityMap, cap: number): ActivityMap {
  const keys = Object.keys(map);
  if (keys.length <= cap) return map;
  keys.sort((a, b) => (map[b] - map[a]) || a.localeCompare(b));
  const out: Record<string, number> = {};
  for (const k of keys.slice(0, cap)) out[k] = map[k];
  return out;
}

/**
 * The sort key actually rendered: the durable value, floated by whichever
 * overlay knows something newer. `max` (not "overlay wins") is the whole
 * contract — an overlay may only ever move a row UP, so a stale local stamp
 * from before a reload can never out-rank fresh remote truth, and vice versa.
 */
export function resolveActivityTs(
  base: number,
  key: string,
  local: ActivityMap,
  remote: ActivityMap,
): number {
  return Math.max(base, local[key] ?? 0, remote[key] ?? 0);
}

/**
 * Parse a persisted LOCAL map back from storage. Tolerant of anything: a
 * hand-edited blob, a future shape, a truncated write — all degrade to "no
 * overlay", which is merely today's behaviour. Also drops entries older than
 * `maxAgeMs`: a stamp from last week says nothing useful about what you were
 * just doing, and keeping it would let an ancient row squat near the top.
 */
export function parseActivityMap(
  raw: unknown,
  now: number,
  maxAgeMs: number,
  cap: number,
): ActivityMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_ACTIVITY;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    if (now - value > maxAgeMs) continue;
    out[key] = value;
  }
  return pruneActivity(out, cap);
}
