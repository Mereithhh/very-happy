/**
 * B-552 — pure model of the ⌘K palette list (no React, no stores), so the
 * selection / filtering / ordering rules are unit-tested in
 * paletteModel.test.ts. Spec: specs/2026-10-command-palette-needs-you.md.
 */
import type { AgentExecution } from '@/sync/agentStatus';
import {
  buildLifecycleColumns,
  URGENT_WAIT_REASONS,
  type BoardItem,
} from '@/screens/board/boardItems';
import {
  parseSidebarQuery,
  sidebarQueryIsEmpty,
  tagsMatchSidebarQuery,
} from '@/screens/sessions/sidebarSearch';

/** Display sections, top to bottom. Keyboard order follows the same list.
 *  `settings` (B-575): item-level settings hits, only for a free-text query. */
export type PaletteGroup = 'needsYou' | 'actions' | 'sessions' | 'terminals' | 'settings' | 'create';
export const PALETTE_GROUP_ORDER: readonly PaletteGroup[] = [
  'needsYou',
  'actions',
  'sessions',
  'terminals',
  'settings',
  'create',
];

/** Settings rows shown in ⌘K for one query. */
export const PALETTE_SETTINGS_LIMIT = 6;

/**
 * B-575: the free text the settings index is searched with, or null when the
 * query carries `#tag` terms (settings have no tags — a tag query is about
 * chats/terminals) or no free text at all.
 */
export function paletteSettingsQuery(query: string): string | null {
  const parsed = parseSidebarQuery(query);
  if (!parsed.text) return null;
  if (!sidebarQueryIsEmpty({ ...parsed, text: '' })) return null;
  return parsed.text;
}

/** Rows in the empty-query 等我看 section. */
export const NEEDS_YOU_LIMIT = 6;

/**
 * The empty-query 等我看 section: chat sessions in the board's waiting column,
 * in the board's own order (buildBoardItems' total order — urgent band
 * longest-waiting first, then the reap band most recent first). No re-sort:
 * one ordering rule shared with the board and the sidebar's status view.
 *
 * The session the user is looking at is left out when it is merely
 * idle/ended (nothing to act on — they are already there); it stays when it
 * is urgent (a permission request on the open session is still 该我处理).
 */
export function selectNeedsYouSessions(
  items: BoardItem[],
  opts: { currentSessionId: string | null; limit?: number },
): BoardItem[] {
  const limit = opts.limit ?? NEEDS_YOU_LIMIT;
  return buildLifecycleColumns(items)
    .waiting.filter((item) => item.kind === 'session')
    .filter(
      (item) =>
        item.key !== opts.currentSessionId ||
        (item.waitReason !== undefined && URGENT_WAIT_REASONS.has(item.waitReason)),
    )
    .slice(0, limit);
}

/**
 * Rows frozen at open time (membership + order don't shuffle under the
 * cursor), rendered with the LIVE board item so the status mark still
 * updates. A key that left the board entirely (archived) drops out.
 */
export function resolveFrozenRows(keys: readonly string[], live: BoardItem[]): BoardItem[] {
  const byKey = new Map(live.map((item) => [item.key, item]));
  return keys.flatMap((key) => {
    const item = byKey.get(key);
    return item ? [item] : [];
  });
}

/**
 * When the 等我看 membership freezes. Not before the session store is ready
 * (`isDataReady`): freezing an empty pre-hydration list — or freezing on the
 * first non-empty board, which a cold open reaches mid-way — would splice a
 * whole section in above the cursor. Once ready, the current selection is
 * frozen even when empty, so nothing is inserted later.
 *
 * Returns the frozen keys, or null = not frozen yet (the section is not shown).
 */
export function freezeNeedsYouKeys(
  frozen: readonly string[] | null,
  dataReady: boolean,
  live: readonly BoardItem[],
): readonly string[] | null {
  if (frozen) return frozen;
  if (!dataReady) return null;
  return live.map((item) => item.key);
}

/** The highlighted row, by key; `index` is where it was last seen. */
export interface PaletteActive {
  key: string;
  index: number;
}

/**
 * Resolve the highlighted row against the current display order. The
 * highlight follows its row's KEY, so rows inserted or removed elsewhere
 * never move it. If its row vanished, the row that slid into its old position
 * takes over (its neighbour below; the new last row when it was last). No
 * highlight yet → the first row. Returns -1 for an empty list.
 */
export function resolveActiveIndex(keys: readonly string[], active: PaletteActive | null): number {
  if (keys.length === 0) return -1;
  if (!active) return 0;
  const at = keys.indexOf(active.key);
  if (at >= 0) return at;
  return Math.min(Math.max(active.index, 0), keys.length - 1);
}

/** ↑/↓ with wrap-around, from the resolved highlight. */
export function moveActive(keys: readonly string[], active: PaletteActive | null, delta: 1 | -1): PaletteActive | null {
  if (keys.length === 0) return null;
  const from = resolveActiveIndex(keys, active);
  const index = (from + delta + keys.length) % keys.length;
  return { key: keys[index], index };
}

/** BoardItem → the sidebar's AgentExecution (same table as Sidebar.tsx executionByKey). */
export function boardItemExecution(item: Pick<BoardItem, 'status' | 'backgroundTasks'>): AgentExecution {
  switch (item.status) {
    case 'working':
      return item.backgroundTasks ? 'background' : 'running';
    case 'attention':
      return 'input';
    case 'unknown':
      return 'unknown';
    case 'ended':
      return 'offline';
    default:
      return 'idle';
  }
}

export interface PaletteMatchable {
  group: PaletteGroup;
  /** lower-cased haystack for substring matching */
  haystack: string;
  /** `#tag` query terms AND-filter on these (sidebar grammar) */
  tags?: string[];
}

/**
 * The palette's existing match (moved out of the component unchanged):
 * empty query → everything; otherwise `#tag` terms filter on row tags and the
 * free-text remainder is a case-insensitive substring match, ranked by match
 * position. Ties keep group order. Items without tags fail tag constraints.
 */
export function filterPaletteItems<T extends PaletteMatchable>(items: T[], query: string): T[] {
  const parsed = parseSidebarQuery(query);
  if (sidebarQueryIsEmpty(parsed)) return items;
  const rank = groupRank();
  return items
    .filter((it) => tagsMatchSidebarQuery(it.tags, parsed))
    .map((it) => ({ it, score: parsed.text ? it.haystack.indexOf(parsed.text) : 0 }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score || rank[a.it.group] - rank[b.it.group])
    .map((x) => x.it);
}

/**
 * Stable regroup into display order. Rendering and ↑↓/Enter both read this
 * one sequence, so the highlighted row is always the one Enter runs.
 */
export function orderPaletteItems<T extends { group: PaletteGroup }>(items: T[]): T[] {
  return PALETTE_GROUP_ORDER.flatMap((g) => items.filter((it) => it.group === g));
}

/**
 * The 「新建对话：<查询>」 row: offered when the query has free text and no
 * chat row matched. Returns the draft for the new chat's composer (the raw
 * query, trimmed — `#tag` terms included, they're the user's words), or null.
 */
export function newChatDraftFor(query: string, matched: readonly { group: PaletteGroup }[]): string | null {
  const parsed = parseSidebarQuery(query);
  if (!parsed.text) return null;
  if (matched.some((it) => it.group === 'sessions' || it.group === 'needsYou')) return null;
  const draft = query.trim();
  return draft ? draft : null;
}

function groupRank(): Record<PaletteGroup, number> {
  return Object.fromEntries(PALETTE_GROUP_ORDER.map((g, i) => [g, i])) as Record<PaletteGroup, number>;
}
