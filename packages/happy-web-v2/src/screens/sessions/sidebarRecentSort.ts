/**
 * sidebarRecentSort — the sidebar's "most recently active on top" auto-sort
 * and the hover freeze that keeps it from yanking a row out from under the
 * pointer. Pure (no react / storage imports) so the semantics stay
 * unit-testable (sidebarRecentSort.test.ts).
 *
 * ── 活跃时间 (the ONE definition of "last active", used by the 列表 view's
 * recent order AND the 状态 view's in-group order) ──────────────────────────
 *
 *   • chat session  → `updatedAt || activeAt || createdAt` (Sidebar.sessionRow).
 *     The session record's own freshness stamp: every message, agent state
 *     push and metadata write bumps it, so "I just talked to it" moves it.
 *
 *   • web terminal  → the tmux session's last activity. The daemon already
 *     pushes it as `MachineTerminal.activityAt` (webTerminal.ts: tmux
 *     `#{session_activity}` for cold sessions, overlaid with the live pty's
 *     `lastOutputAt` for attached ones — both typing and program output move
 *     it, since keystrokes echo back through the pty). terminalPushOps maps it
 *     onto `TerminalSession.updatedAt` with `?? createdAt`, so an OLD daemon
 *     that doesn't send the field degrades to creation order instead of
 *     breaking.
 *
 * Both of those are DURABLE values: correct, and slow. They are floated at
 * render time by the two fast lanes in `sync/activityOverlay.ts` — my own
 * interactions in this browser (instant, zero network) and the daemon's
 * ephemeral `terminal-activity` frames (~1s, which is what lets pure OUTPUT
 * float without paying for a daemonState write). Sidebar.tsx does that merge
 * with max() while building rows, so `ts` here is already the resolved value
 * and this module stays a pure sorter that knows nothing about lanes.
 *
 * Terminals and chats sort in ONE mixed sequence — a terminal is a session
 * too, and "the thing I just touched is on top" only works if nothing is
 * pinned above by kind.
 */

/** 列表 view order: 'recent' = auto by last activity, 'manual' = sidebarOrder. */
export type SidebarSortMode = 'recent' | 'manual';

/**
 * How long a *stationary* pointer inside the list keeps the order frozen.
 *
 * This is the safety valve for an ABANDONED cursor, not the normal release
 * path — leaving the list releases instantly, so the only way to reach this
 * timeout is to hover the list and stop moving.
 *
 * It was 1500ms when the only thing that could reorder the list was a durable
 * activity change, i.e. at most once a MINUTE for pure output (the daemon's 60s
 * signature bucket). The realtime overlay raised that ceiling to about once a
 * second, which turned the gap between "pointer went still" and "user clicks"
 * into a live mis-click window ~60x more often: park the cursor on row 3 to
 * read it, some background terminal prints, row 3 slides away, and the click
 * lands on a different session. Reading a row label and deciding to click it
 * takes seconds, so the hold has to outlive that pause. 8s still un-freezes an
 * abandoned cursor quickly enough that nobody thinks the sidebar is broken —
 * and only the SEQUENCE is ever held, so row content, status dots and new rows
 * keep updating throughout.
 */
export const REORDER_HOLD_MS = 8000;

/**
 * Read the synced `sidebarSort` field. Anything that isn't the explicit
 * opt-in 'manual' — undefined (never set / old client / field stripped by a
 * schema mismatch), null, a future enum value — is 'recent', the default.
 */
export function resolveSidebarSort(value: unknown): SidebarSortMode {
  return value === 'manual' ? 'manual' : 'recent';
}

/**
 * Most recently active first. `ts` is the activity time defined in the header;
 * the row-key tiebreak keeps the sort total (two rows stamped in the same
 * millisecond render identically on every device). Never mutates the input.
 */
export function sortRowsByRecent<T extends { key: string; ts: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (b.ts - a.ts) || a.key.localeCompare(b.key));
}

export interface ReorderHoldInput {
  /** Is the pointer currently inside the list? */
  pointerInside: boolean;
  /** Timestamp of the last pointer movement inside the list (null = never). */
  lastPointerAt: number | null;
  now: number;
  holdMs?: number;
}

/**
 * Should the rendered order be frozen right now?
 *
 * Yes while the pointer is inside the list AND has moved within the last
 * `holdMs`. Leaving the list releases immediately (nothing is under the
 * pointer to protect); a pointer parked motionless inside also releases after
 * `holdMs`, so an abandoned cursor can't freeze the sidebar forever.
 */
export function shouldHoldReorder(input: ReorderHoldInput): boolean {
  if (!input.pointerInside || input.lastPointerAt === null) return false;
  return input.now - input.lastPointerAt < (input.holdMs ?? REORDER_HOLD_MS);
}

/**
 * Render `next` in the frozen sequence `heldKeys` (the order that was on
 * screen when the pointer entered), so no row slides under the pointer:
 *
 *   • rows present in both keep their HELD relative positions — zero movement,
 *     which is the whole point;
 *   • rows that disappeared (archived / killed / deleted) are simply gone —
 *     holding a dead row would be a lie, and its removal is user-caused;
 *   • rows that appeared are appended at the BOTTOM, never inserted above the
 *     pointer (a new row on top would shift the entire list down by a row —
 *     exactly the mis-click this hold exists to prevent). They snap to their
 *     real place the moment the hold releases.
 *
 * `heldKeys` may be a SUPERSET of `next` (the 状态 view holds one flat
 * sequence and applies it to each lifecycle group), so missing keys are fine.
 * Returns the SAME array when the hold changes nothing, so callers can skip a
 * re-render.
 */
export function applyReorderHold<T extends { key: string }>(
  heldKeys: readonly string[] | null,
  next: T[],
): T[] {
  if (!heldKeys || heldKeys.length === 0 || next.length === 0) return next;
  const rank = new Map<string, number>();
  heldKeys.forEach((k, i) => {
    if (!rank.has(k)) rank.set(k, i); // defensive: dedupe a corrupt sequence
  });
  const held: T[] = [];
  const fresh: T[] = [];
  for (const r of next) (rank.has(r.key) ? held : fresh).push(r);
  held.sort((a, b) => rank.get(a.key)! - rank.get(b.key)!);
  const out = [...held, ...fresh];
  return out.every((r, i) => r === next[i]) ? next : out;
}
