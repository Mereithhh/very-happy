/**
 * sidebarAttention — the sidebar row's two-level signal (B-085: "通知会点进去
 * 的对话在 list 里要一眼可辨").
 *
 * Level 2 「待处理」(attention → accent): the agent is blocked on the user
 * RIGHT NOW — exactly the board's urgent waiting band (permission request /
 * terminal needs_input / LLM review / LLM blocked). The sidebar never
 * re-classifies: it consumes `BoardItem.lifecycle`/`waitReason` (derived by
 * boardItems.lifecycleOf inside buildBoardItems, offline gates included), so
 * the accent rows are always the ones the board — and the notifications that
 * deep-link into them — call urgent.
 *
 * Level 1 「未读」(unread → --danger dot): the agent finished a turn while the
 * user wasn't looking (storage.unreadSessionIds, seeded from MMKV so a refresh
 * keeps it — sidebarUnread.ts; cleared when the session is opened). "跑完待看"
 * earns a visible marker but NOT accent: accent strictly means live/waiting-on-you
 * (tokens.css discipline), and painting every finished turn teal would drown the
 * real signal. B-312 made it red — the previous --text dot was literally the
 * row's own ink color and read as decoration.
 *
 * attention ≻ unread ≻ null. Pure — unit tests in sidebarAttention.test.ts.
 */
import { URGENT_WAIT_REASONS, type BoardItem } from '@/screens/board/boardItems';

export type RowSignal = 'attention' | 'unread' | null;

/** Is this board item blocked on the user right now? (urgent waiting band —
 *  same set as the board's urgent band and the notification triggers) */
export function isUrgentWaiting(item: Pick<BoardItem, 'lifecycle' | 'waitReason'>): boolean {
  return (
    item.lifecycle === 'waiting' &&
    item.waitReason !== undefined &&
    URGENT_WAIT_REASONS.has(item.waitReason)
  );
}

/** Row keys (session id / `t:<terminalId>` — BoardItem.key already matches the
 *  sidebar's Row.key scheme) that need the user right now. */
export function attentionKeysOf(
  items: ReadonlyArray<Pick<BoardItem, 'key' | 'lifecycle' | 'waitReason'>>,
): Set<string> {
  const keys = new Set<string>();
  for (const it of items) {
    if (isUrgentWaiting(it)) keys.add(it.key);
  }
  return keys;
}

/** The row's rendered signal: attention (accent) outranks unread (text-stage). */
export function rowSignalOf(opts: { attention: boolean; unread: boolean }): RowSignal {
  if (opts.attention) return 'attention';
  if (opts.unread) return 'unread';
  return null;
}
