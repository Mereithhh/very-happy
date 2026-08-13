/**
 * sidebarStatusView — the sidebar's "status" display mode, derived from the
 * BOARD's lifecycle classification. The sidebar never classifies on its own:
 * it consumes `BoardItem.lifecycle` (boardItems.lifecycleOf, applied inside
 * buildBoardItems) and the board's total order, so the sidebar and the board
 * can never disagree about what is running vs. waiting. Pure; unit-tested.
 */
import type { BoardItem } from '@/screens/board/boardItems';
import { buildCompletedEntries } from '@/screens/board/boardItems';
import type { Session } from '@/sync/storageTypes';
import { sortRowsByRecent } from './sidebarRecentSort';

export interface StatusGroups<R> {
  /** 等我看 — board `waiting` items plus any off-board rows, most recently
   *  active first. */
  waiting: R[];
  /** 进行中 — board `running` items, most recently active first. */
  running: R[];
}

/**
 * Group sidebar rows by the board's lifecycle verdict.
 *
 * The board still owns the CLASSIFICATION (BoardItem.lifecycle, applied inside
 * buildBoardItems) — there is no second classifier, so the sidebar and the
 * board can never disagree about what is running vs. waiting. But the order
 * WITHIN each group is the sidebar's own: most recently active first, the
 * same "the thing I just touched is on top" model as the 列表 view's recent
 * sort (sidebarRecentSort — see it for what `ts` means per row kind). The
 * board's total order (attention longest-waiting first) is deliberately NOT
 * reused here: it answers "what have I neglected longest", a different
 * question from the sidebar's "where was I".
 *
 * Rows the board doesn't carry (an online-machine-less terminal older than
 * the board's 24h ended window — active sessions always classify) have
 * nothing running by definition, so they join the waiting group and sort into
 * it by the same activity key.
 */
export function groupRowsByLifecycle<R extends { key: string; ts: number }>(
  rows: R[],
  boardItems: ReadonlyArray<Pick<BoardItem, 'key' | 'lifecycle'>>,
): StatusGroups<R> {
  const lifecycleOf = new Map<string, BoardItem['lifecycle']>();
  for (const it of boardItems) {
    if (!lifecycleOf.has(it.key)) lifecycleOf.set(it.key, it.lifecycle);
  }
  const running: R[] = [];
  const waiting: R[] = [];
  for (const r of rows) {
    if (lifecycleOf.get(r.key) === 'running') running.push(r);
    else waiting.push(r); // waiting, or off-board (nothing running by definition)
  }
  return { running: sortRowsByRecent(running), waiting: sortRowsByRecent(waiting) };
}

/**
 * 已完成(今日) — sessions completed via the board's ✓ within the 24h window,
 * newest first. Same source as the board's Done column (buildCompletedEntries);
 * task records are dropped — tasks have no sidebar row to render.
 */
export function completedTodaySessions(sessions: Session[], now: number): Session[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const out: Session[] = [];
  for (const e of buildCompletedEntries(sessions, [], now)) {
    if (e.kind !== 'session') continue;
    const s = byId.get(e.key.slice('done:s:'.length));
    if (s) out.push(s);
  }
  return out;
}
