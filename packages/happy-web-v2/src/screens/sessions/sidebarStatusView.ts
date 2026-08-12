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

export interface StatusGroups<R> {
  /** 等我看 — board `waiting` items (urgent band first, then the reap band —
   *  the board's own order), then any off-board rows (below). */
  waiting: R[];
  /** 进行中 — board `running` items, most recent activity first. */
  running: R[];
}

/**
 * Group sidebar rows by the board's lifecycle verdict. Within each group the
 * rows follow the BOARD order (buildBoardItems' total order: attention
 * longest-waiting first → working → idle/ended most-recent first), so both
 * surfaces always tell the same story.
 *
 * Rows the board doesn't carry (an online-machine-less terminal older than
 * the board's 24h ended window — active sessions always classify) have
 * nothing running by definition: they tail the waiting group, most recent
 * first, stable key tiebreak.
 */
export function groupRowsByLifecycle<R extends { key: string; ts: number }>(
  rows: R[],
  boardItems: ReadonlyArray<Pick<BoardItem, 'key' | 'lifecycle'>>,
): StatusGroups<R> {
  const board = new Map<string, { index: number; lifecycle: BoardItem['lifecycle'] }>();
  boardItems.forEach((it, index) => {
    if (!board.has(it.key)) board.set(it.key, { index, lifecycle: it.lifecycle });
  });
  const running: R[] = [];
  const waiting: R[] = [];
  const offBoard: R[] = [];
  for (const r of rows) {
    const entry = board.get(r.key);
    if (!entry) offBoard.push(r);
    else if (entry.lifecycle === 'running') running.push(r);
    else waiting.push(r);
  }
  const byBoardIndex = (a: R, b: R) => board.get(a.key)!.index - board.get(b.key)!.index;
  running.sort(byBoardIndex);
  waiting.sort(byBoardIndex);
  offBoard.sort((a, b) => (b.ts - a.ts !== 0 ? b.ts - a.ts : a.key.localeCompare(b.key)));
  return { running, waiting: [...waiting, ...offBoard] };
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
