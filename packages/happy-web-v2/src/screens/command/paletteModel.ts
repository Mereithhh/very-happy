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
import { EMPTY_FILTERS, type ResultSnippet, type SessionSearchFilters, type SessionSearchRow } from '@/screens/search/sessionSearch';
import {
  parseSidebarQuery,
  sidebarQueryIsEmpty,
} from '@/screens/sessions/sidebarSearch';
import { parseSearchQuery, rankSearch, searchQueryIsEmpty, type PreparedSearch, type SearchMatch } from '@/screens/search/searchMatch';

/** Display sections, top to bottom. Keyboard order follows the same list.
 *  `settings` (B-575): item-level settings hits, only for a free-text query.
 *  `content` (B-865): sessions found by what was said (daemon `history-search`
 *  + loaded messages) whose title did not match, and importable conversations. */
export type PaletteGroup = 'needsYou' | 'actions' | 'sessions' | 'projects' | 'teams' | 'issues' | 'content' | 'terminals' | 'settings' | 'create';
export const PALETTE_GROUP_ORDER: readonly PaletteGroup[] = [
  'needsYou',
  'actions',
  // B-895: projects and teams by name / members / sharer (free-text queries only).
  // Above 「会话」: a handful of rows at most, and a long session list would push them off screen.
  'projects',
  'teams',
  'sessions',
  // B-873: issues by key / title (only while the server has Issues on)
  'issues',
  'content',
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

/** Key of the 「新建对话：<查询>」 row. */
export const CREATE_ROW_KEY = 'create:new-chat';

/**
 * B-865: content results arrive ~250 ms after typing, above the create row.
 * If the highlight landed on 「新建对话」 only because nothing else matched yet
 * (the user has not moved it), it moves to the first result once one exists —
 * Enter should open what was found, not start a chat. A highlight the user
 * chose stays put (rows are tracked by key).
 */
export function adoptFirstResult(keys: readonly string[], active: PaletteActive | null, chosen: boolean): PaletteActive | null {
  if (chosen || active?.key !== CREATE_ROW_KEY || keys.length === 0 || keys[0] === CREATE_ROW_KEY) return active;
  return { key: keys[0], index: 0 };
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
  /** B-895: the row's typed fields (title, project, team, tags, machine, path…; searchMatch). */
  search: PreparedSearch;
}

export interface PaletteHit<T> {
  it: T;
  /** null for an empty query (nothing to explain or highlight). */
  match: SearchMatch | null;
}

/**
 * B-895: the palette runs the one search rule (searchMatch.rankSearch) —
 * every whitespace term must occur (AND, across fields), title hits rank above
 * project / team / member hits, then tags, then machine / path; ties go to the
 * unarchived, then the most recent, then input order. `#tag` terms filter on
 * row tags (sidebar grammar). Empty query → every row, unranked. The display
 * still regroups (orderPaletteItems), so ranking orders rows inside a group.
 */
export function filterPaletteItems<T extends PaletteMatchable>(items: readonly T[], query: string): PaletteHit<T>[] {
  const q = parseSearchQuery(query);
  if (searchQueryIsEmpty(q)) return items.map((it) => ({ it, match: null }));
  return rankSearch(items, q, (it) => it.search).map(({ row, match }) => ({ it: row, match }));
}

/**
 * Stable regroup into display order. Rendering and ↑↓/Enter both read this
 * one sequence, so the highlighted row is always the one Enter runs.
 * B-895b: a chat whose title equals the whole query (`exactTitle`) moves
 * ahead of the 项目 / 团队 rows, so Enter opens that chat rather than a
 * same-named project or team; the other chats stay below them.
 */
export function orderPaletteItems<T extends { group: PaletteGroup; exactTitle?: boolean }>(items: T[]): T[] {
  const lifted = items.filter((it) => it.group === 'sessions' && it.exactTitle);
  const rest = lifted.length ? items.filter((it) => !lifted.includes(it)) : items;
  return PALETTE_GROUP_ORDER.flatMap((g) => [
    ...(g === 'projects' ? lifted : []),
    ...rest.filter((it) => it.group === g),
  ]);
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

/**
 * B-865: content search starts at this many characters of free text (a single
 * letter matches nearly every transcript and would fan out to every machine).
 */
export const CONTENT_MIN_CHARS = 2;

/**
 * B-865: the filter bar's starting point. Archived sessions stay out unless
 * the status chip says 「含归档」/「仅归档」 — the palette lists sessions with an
 * empty query too, and the sidebar list it mirrors has no archived rows.
 */
export const PALETTE_DEFAULT_FILTERS: SessionSearchFilters = { ...EMPTY_FILTERS, status: 'live' };

export function paletteFiltersActive(f: SessionSearchFilters): boolean {
  return (Object.keys(PALETTE_DEFAULT_FILTERS) as (keyof SessionSearchFilters)[]).some((k) => f[k] !== PALETTE_DEFAULT_FILTERS[k]);
}

/** The free text sent to the content search, or '' below CONTENT_MIN_CHARS. */
export function contentSearchText(text: string): string {
  return [...text.replace(/\s+/g, '')].length >= CONTENT_MIN_CHARS ? text : '';
}

export interface PaletteSearchSplit {
  /** Snippets for sessions the 「会话」 group already shows (title match): one row, not two. */
  attach: Map<string, ResultSnippet[]>;
  /** Sessions matched on metadata the palette's substring match missed
   *  (every term somewhere in title / folder / project / machine): join 「会话」. */
  titleRows: SessionSearchRow[];
  /** 「对话内容」: sessions found only by what was said, then importable conversations. */
  contentRows: SessionSearchRow[];
}

/**
 * B-865: split the session-search rows between the palette's groups so a
 * session appears once. `titleIds` = sessions already in 「会话」.
 */
export function splitSearchRows(rows: readonly SessionSearchRow[], titleIds: ReadonlySet<string>): PaletteSearchSplit {
  const attach = new Map<string, ResultSnippet[]>();
  const titleRows: SessionSearchRow[] = [];
  const contentRows: SessionSearchRow[] = [];
  for (const row of rows) {
    if (row.importable) { contentRows.push(row); continue; }
    if (!row.sessionId) continue;
    if (titleIds.has(row.sessionId)) {
      if (row.snippets.length) attach.set(row.sessionId, row.snippets);
    } else if (row.snippets.length) {
      contentRows.push(row);
    } else if (row.metaHit) {
      titleRows.push(row);
    }
  }
  return { attach, titleRows, contentRows };
}
