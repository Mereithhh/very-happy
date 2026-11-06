import { describe, it, expect } from 'vitest';
import { buildBoardItems, type BoardInput, type BoardItem } from '@/screens/board/boardItems';
import type { Session, Machine } from '@/sync/storageTypes';
import {
  boardItemExecution,
  filterPaletteItems,
  freezeNeedsYouKeys,
  moveActive,
  newChatDraftFor,
  resolveActiveIndex,
  orderPaletteItems,
  resolveFrozenRows,
  selectNeedsYouSessions,
  NEEDS_YOU_LIMIT,
  paletteSettingsQuery,
  type PaletteGroup,
  CONTENT_MIN_CHARS,
  contentSearchText,
  PALETTE_DEFAULT_FILTERS,
  paletteFiltersActive,
  splitSearchRows,
  adoptFirstResult,
  CREATE_ROW_KEY,
} from './paletteModel';
import type { ResultSnippet, SessionSearchRow } from '@/screens/search/sessionSearch';
import { pathFields, prepareSearch, type PreparedSearch } from '@/screens/search/searchMatch';

const NOW = 1_700_000_000_000;

function mkSession(over: Partial<Session> & { id: string }): Session {
  return {
    seq: 0,
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 60_000,
    active: true,
    activeAt: NOW - 60_000,
    metadata: { path: '/p', host: 'h', machineId: 'm1', summary: { text: over.id, updatedAt: NOW } } as Session['metadata'],
    metadataVersion: 0,
    agentState: null,
    agentStateVersion: 0,
    thinking: false,
    thinkingAt: 0,
    presence: 'online',
    ...over,
  } as Session;
}

const machine = { id: 'm1', active: true, metadata: { host: 'h' } } as unknown as Machine;

function board(sessions: Session[], extra: Partial<BoardInput> = {}): BoardItem[] {
  return buildBoardItems({
    sessions,
    terminals: [],
    agentStates: {},
    machines: [machine],
    now: NOW,
    sessionFresh: Object.fromEntries(sessions.map((s) => [s.id, true])),
    terminalFresh: {},
    ...extra,
  });
}

const permission = (createdAt: number) =>
  ({ requests: { r1: { tool: 'Bash', arguments: {}, createdAt } } }) as unknown as Session['agentState'];

describe('selectNeedsYouSessions', () => {
  it('takes the board waiting column in board order: urgent longest-wait first, then idle newest first', () => {
    const items = board([
      mkSession({ id: 'idle-old', updatedAt: NOW - 50_000 }),
      mkSession({ id: 'perm-new', agentState: permission(NOW - 1_000) }),
      mkSession({ id: 'running', thinking: true }),
      mkSession({ id: 'idle-new', updatedAt: NOW - 5_000 }),
      mkSession({ id: 'perm-old', agentState: permission(NOW - 9_000) }),
    ]);
    const keys = selectNeedsYouSessions(items, { currentSessionId: null }).map((i) => i.key);
    expect(keys).toEqual(['perm-old', 'perm-new', 'idle-new', 'idle-old']);
    // same order as the board's own waiting column
    expect(keys).toEqual(items.filter((i) => i.lifecycle === 'waiting').map((i) => i.key));
  });

  it('caps at NEEDS_YOU_LIMIT', () => {
    const items = board(Array.from({ length: 9 }, (_, n) => mkSession({ id: `s${n}`, updatedAt: NOW - n * 1000 })));
    expect(selectNeedsYouSessions(items, { currentSessionId: null })).toHaveLength(NEEDS_YOU_LIMIT);
    expect(selectNeedsYouSessions(items, { currentSessionId: null, limit: 2 }).map((i) => i.key)).toEqual(['s0', 's1']);
  });

  it('omits the current session when it is merely idle, keeps it when urgent', () => {
    const items = board([
      mkSession({ id: 'cur-idle' }),
      mkSession({ id: 'cur-perm', agentState: permission(NOW - 1_000) }),
    ]);
    expect(selectNeedsYouSessions(items, { currentSessionId: 'cur-idle' }).map((i) => i.key)).toEqual(['cur-perm']);
    expect(selectNeedsYouSessions(items, { currentSessionId: 'cur-perm' }).map((i) => i.key)).toEqual(['cur-perm', 'cur-idle']);
  });

  it('omits the current session when it has ended (reap band, not urgent)', () => {
    const items = board([mkSession({ id: 'gone', presence: 'offline' as unknown as Session['presence'], updatedAt: NOW - 1000 })]);
    expect(items[0]?.waitReason).toBe('ended');
    expect(selectNeedsYouSessions(items, { currentSessionId: 'gone' })).toEqual([]);
    expect(selectNeedsYouSessions(items, { currentSessionId: null }).map((i) => i.key)).toEqual(['gone']);
  });

  it('only lists chat sessions, never terminals', () => {
    const items = board([mkSession({ id: 's1' })], {
      terminals: [{ id: 'T1', machineId: 'm1', machineName: 'h', title: 'term', createdAt: NOW, updatedAt: NOW } as never],
    });
    expect(items.some((i) => i.kind === 'terminal' && i.lifecycle === 'waiting')).toBe(true);
    expect(selectNeedsYouSessions(items, { currentSessionId: null }).map((i) => i.key)).toEqual(['s1']);
  });
});

describe('resolveFrozenRows', () => {
  it('keeps the frozen order, uses live items, drops vanished keys', () => {
    const live = board([mkSession({ id: 'a', thinking: true }), mkSession({ id: 'b' })]);
    const rows = resolveFrozenRows(['b', 'gone', 'a'], live);
    expect(rows.map((r) => r.key)).toEqual(['b', 'a']);
    // 'a' was waiting at freeze time but is running now — the live status shows
    expect(rows[1]?.status).toBe('working');
  });
});

describe('boardItemExecution', () => {
  it('maps board status to the sidebar execution table', () => {
    expect(boardItemExecution({ status: 'working' })).toBe('running');
    expect(boardItemExecution({ status: 'working', backgroundTasks: 2 })).toBe('background');
    expect(boardItemExecution({ status: 'attention' })).toBe('input');
    expect(boardItemExecution({ status: 'unknown' })).toBe('unknown');
    expect(boardItemExecution({ status: 'ended' })).toBe('offline');
    expect(boardItemExecution({ status: 'idle' })).toBe('idle');
  });
});

type Row = { key: string; group: PaletteGroup; search: PreparedSearch };
const row = (key: string, group: PaletteGroup, title: string, extra: { keywords?: string; path?: string; tags?: string[] } = {}): Row => ({
  key, group, search: prepareSearch({
    title,
    fields: [...(extra.keywords ? [{ kind: 'keyword' as const, text: extra.keywords }] : []), ...pathFields(extra.path)],
    tags: extra.tags,
  }),
});
const rows: Row[] = [
  row('a:new', 'actions', 'New chat'),
  row('a:hist', 'actions', '搜索历史对话…', { keywords: 'search history full text' }),
  row('s:1', 'sessions', 'Fix login bug', { path: '/home/u/proj', tags: ['p0', 'web'] }),
  row('s:2', 'sessions', 'Chat about release'),
  row('t:1', 'terminals', 'build server devbox', { tags: ['web'] }),
];
const keys = (hits: { it: Row }[]) => hits.map((h) => h.it.key);

describe('filterPaletteItems (B-895: searchMatch)', () => {
  it('returns everything, unranked, for an empty query', () => {
    expect(keys(filterPaletteItems(rows, '   '))).toEqual(rows.map((r) => r.key));
  });
  it('title prefix ranks above a word-start hit', () => {
    expect(keys(filterPaletteItems(rows, 'chat'))).toEqual(['s:2', 'a:new']);
  });
  it('#tag terms AND-filter on tags; untagged rows fail', () => {
    expect(keys(filterPaletteItems(rows, '#web'))).toEqual(['s:1', 't:1']);
    expect(keys(filterPaletteItems(rows, '#web build'))).toEqual(['t:1']);
  });
  it('keeps the B-549 search-history action reachable by its hidden keywords', () => {
    expect(keys(filterPaletteItems(rows, 'history'))).toEqual(['a:hist']);
  });
  it('multi-word queries AND across fields (was: one whole substring)', () => {
    expect(keys(filterPaletteItems(rows, 'login proj'))).toEqual(['s:1']);
  });
});

describe('orderPaletteItems (B-895 groups)', () => {
  it('projects and teams sit between actions and chats', () => {
    const E = prepareSearch({ title: '' });
    const mixed: Row[] = [
      { key: 's:1', group: 'sessions', search: E },
      { key: 'team:1', group: 'teams', search: E },
      { key: 'project:1', group: 'projects', search: E },
      { key: 'a:1', group: 'actions', search: E },
    ];
    expect(orderPaletteItems(mixed).map((r) => r.key)).toEqual(['a:1', 'project:1', 'team:1', 's:1']);
  });
});

describe('orderPaletteItems — exact chat title beats a same-named project / team (B-895b, QA57 P1)', () => {
  // QA57's shape (names neutralised): a project, a project with a team, and chats titled exactly like them.
  const sess = (key: string, title: string, fields: { kind: 'project' | 'team'; text: string }[] = []) =>
    ({ key, group: 'sessions' as const, search: prepareSearch({ title, fields }) });
  const items = [
    { key: 'project:ledger', group: 'projects' as const, search: prepareSearch({ title: '家庭账本' }) },
    { key: 'project:vh', group: 'projects' as const, search: prepareSearch({ title: 'Nimbus', fields: [{ kind: 'team', text: 'Nimbus 研发' }] }) },
    { key: 'team:vh', group: 'teams' as const, search: prepareSearch({ title: 'Nimbus 研发', fields: [{ kind: 'project', text: 'Nimbus' }] }) },
    sess('s:ledger', '家庭账本', [{ kind: 'project', text: '家庭账本' }]),
    sess('s:nb-dev', 'Nimbus 研发'),
    sess('s:vh', 'Nimbus'),
    sess('s:in-project', '整理笔记', [{ kind: 'project', text: '家庭账本' }]),
    sess('s:vh-prefix', 'Nimbus 发版'),
  ];
  const order = (q: string) =>
    orderPaletteItems(filterPaletteItems(items, q).map(({ it, match }) => ({ ...it, exactTitle: match?.exactTitle }))).map((r) => r.key);
  it('「家庭账本」: the chat first, then the project, then the project\'s other chats', () => {
    expect(order('家庭账本')).toEqual(['s:ledger', 'project:ledger', 's:in-project']);
  });
  it('「Nimbus 研发」: the chat ahead of the project (via its team) and the team', () => {
    expect(order('Nimbus 研发')[0]).toBe('s:nb-dev');
    expect(order('Nimbus 研发').slice(1, 3)).toEqual(['project:vh', 'team:vh']);
  });
  it('「Nimbus」: the exact chat first; prefix-only chats stay below the project / team rows', () => {
    const o = order('Nimbus');
    expect(o[0]).toBe('s:vh');
    expect(o.indexOf('project:vh')).toBeLessThan(o.indexOf('s:vh-prefix'));
    expect(o.indexOf('project:vh')).toBeLessThan(o.indexOf('s:nb-dev'));
  });
  it('no chat titled exactly the query → the project row stays first (Enter opens the project)', () => {
    expect(order('nimbus 研').slice(0, 2)).toEqual(['project:vh', 'team:vh']);
    expect(order('家庭')[0]).toBe('project:ledger');
  });
  it('full-width / case variants of the title count as exact', () => {
    expect(order('ｎｉｍｂｕｓ')[0]).toBe('s:vh');
  });
});

describe('orderPaletteItems', () => {
  it('regroups into display order, stable inside a group', () => {
    const E = prepareSearch({ title: '' });
    const mixed: Row[] = [
      { key: 'create', group: 'create', search: E },
      { key: 's:2', group: 'sessions', search: E },
      { key: 'a:1', group: 'actions', search: E },
      { key: 'n:1', group: 'needsYou', search: E },
      { key: 's:1', group: 'sessions', search: E },
      { key: 't:1', group: 'terminals', search: E },
      { key: 'set:1', group: 'settings', search: E },
    ];
    // B-575: 设置 sits after chats/terminals and before the create row.
    expect(orderPaletteItems(mixed).map((r) => r.key)).toEqual(['n:1', 'a:1', 's:2', 's:1', 't:1', 'set:1', 'create']);
  });
});

describe('paletteSettingsQuery (B-575)', () => {
  it('passes free text through, lower-cased', () => {
    expect(paletteSettingsQuery('  Quiet Hours ')).toBe('quiet hours');
  });
  it('no settings search for tag queries or an empty query', () => {
    expect(paletteSettingsQuery('sound #web')).toBeNull();
    expect(paletteSettingsQuery('#')).toBeNull();
    expect(paletteSettingsQuery('   ')).toBeNull();
  });
});

describe('newChatDraftFor', () => {
  it('offers the raw trimmed query when no chat matched', () => {
    expect(newChatDraftFor('  refactor the auth flow ', [{ group: 'actions' }])).toBe('refactor the auth flow');
    expect(newChatDraftFor('deploy #web', [])).toBe('deploy #web');
  });
  it('no offer when a chat row matched', () => {
    expect(newChatDraftFor('login', [{ group: 'sessions' }])).toBeNull();
    expect(newChatDraftFor('login', [{ group: 'needsYou' }])).toBeNull();
  });
  it('no offer for empty or tag-only queries', () => {
    expect(newChatDraftFor('', [])).toBeNull();
    expect(newChatDraftFor('   ', [])).toBeNull();
    expect(newChatDraftFor('#web', [])).toBeNull();
    expect(newChatDraftFor('#', [])).toBeNull();
  });
  it('terminal-only matches still offer a new chat', () => {
    expect(newChatDraftFor('build', [{ group: 'terminals' }])).toBe('build');
  });
});

describe('freezeNeedsYouKeys (review #1: freeze only once the store is ready)', () => {
  const live = board([mkSession({ id: 'a' }), mkSession({ id: 'b', updatedAt: NOW - 90_000 })]);
  it('does not freeze (section hidden) before isDataReady, even with board rows', () => {
    expect(freezeNeedsYouKeys(null, false, live)).toBeNull();
  });
  it('freezes at readiness — an empty selection freezes too, so nothing is spliced in later', () => {
    expect(freezeNeedsYouKeys(null, true, [])).toEqual([]);
    const frozenEmpty = freezeNeedsYouKeys(null, true, []);
    expect(freezeNeedsYouKeys(frozenEmpty, true, live)).toEqual([]);
  });
  it('keeps the first frozen membership/order once set', () => {
    const frozen = freezeNeedsYouKeys(null, true, live);
    expect(frozen).toEqual(['a', 'b']);
    const reordered = [...live].reverse();
    expect(freezeNeedsYouKeys(frozen, true, reordered)).toBe(frozen);
  });
  it('cold open: rows arriving after readiness-pending do not move a pinned highlight', () => {
    // panel opened before data: only actions are listed and the first is pinned
    const before = ['a:new-terminal', 'a:new-chat'];
    const pinned = { key: before[resolveActiveIndex(before, null)], index: 0 };
    // data arrives: 等我看 section rendered on top
    const after = ['needs:a', 'needs:b', ...before];
    expect(after[resolveActiveIndex(after, pinned)]).toBe('a:new-terminal');
  });
});

describe('resolveActiveIndex / moveActive (review #2: highlight by key)', () => {
  const keys = ['needs:a', 'needs:b', 'needs:c', 'a:x'];
  it('no highlight yet → first row; empty list → -1', () => {
    expect(resolveActiveIndex(keys, null)).toBe(0);
    expect(resolveActiveIndex([], null)).toBe(-1);
    expect(resolveActiveIndex([], { key: 'needs:a', index: 0 })).toBe(-1);
  });
  it('follows the key when rows move', () => {
    expect(resolveActiveIndex(['a:x', 'needs:b'], { key: 'needs:b', index: 1 })).toBe(1);
    expect(resolveActiveIndex(['z', 'y', 'needs:b'], { key: 'needs:b', index: 0 })).toBe(2);
  });
  it('frozen row removed → Enter lands on the row that slid into its place, never elsewhere', () => {
    // 'b' highlighted, then its session is archived (resolveFrozenRows drops it)
    const live = board([mkSession({ id: 'a' }), mkSession({ id: 'c', updatedAt: NOW - 90_000 })]);
    const rows = resolveFrozenRows(['a', 'b', 'c'], live).map((r) => `needs:${r.key}`);
    const after = [...rows, 'a:x'];
    expect(after).toEqual(['needs:a', 'needs:c', 'a:x']);
    expect(after[resolveActiveIndex(after, { key: 'needs:b', index: 1 })]).toBe('needs:c');
  });
  it('last row removed → falls back to the new last row', () => {
    expect(resolveActiveIndex(['p', 'q'], { key: 'r', index: 2 })).toBe(1);
  });
  it('arrows wrap and continue from the resolved row', () => {
    expect(moveActive(keys, null, 1)).toEqual({ key: 'needs:b', index: 1 });
    expect(moveActive(keys, null, -1)).toEqual({ key: 'a:x', index: 3 });
    expect(moveActive(keys, { key: 'a:x', index: 3 }, 1)).toEqual({ key: 'needs:a', index: 0 });
    expect(moveActive(['needs:a', 'needs:c'], { key: 'needs:b', index: 1 }, 1)).toEqual({ key: 'needs:a', index: 0 });
    expect(moveActive([], null, 1)).toBeNull();
  });
});

describe('B-865 one search entry: content rows', () => {
  const row = (over: Partial<SessionSearchRow> & { key: string }): SessionSearchRow => ({
    title: over.key, subtitle: '', titleRanges: [], subtitleRanges: [], updatedAt: NOW, archived: false, metaHit: false, snippets: [], ...over,
  });
  const snip = (text: string): ResultSnippet => ({ source: 'content', role: 'user', text, ranges: [[0, 2]] });

  it('a title match keeps one row: its snippets attach to the 「会话」 row, never a second row in 「对话内容」', () => {
    const split = splitSearchRows([
      row({ key: 's:a', sessionId: 'a', metaHit: true, snippets: [snip('hi there')] }),
      row({ key: 's:b', sessionId: 'b', snippets: [snip('only said here')] }),
    ], new Set(['a']));
    expect(split.attach.get('a')).toEqual([snip('hi there')]);
    expect(split.contentRows.map((r) => r.key)).toEqual(['s:b']);
    expect(split.titleRows).toEqual([]);
  });

  it('a metadata-only match the substring filter missed joins 「会话」; importable rows go to 「对话内容」; nothing is duplicated', () => {
    const imp = row({ key: 'i:m1:claude:x', importable: { machineId: 'm1', entry: {} as never }, snippets: [snip('xx')] });
    const split = splitSearchRows([
      row({ key: 's:c', sessionId: 'c', metaHit: true }),
      row({ key: 's:a', sessionId: 'a', metaHit: true }),
      imp,
    ], new Set(['a']));
    expect(split.titleRows.map((r) => r.sessionId)).toEqual(['c']);
    expect(split.contentRows).toEqual([imp]);
    expect(split.attach.size).toBe(0);
    const ids = [...split.titleRows, ...split.contentRows].map((r) => r.sessionId).filter(Boolean);
    expect(ids).not.toContain('a');
  });

  it('content search starts at two characters (CJK counts per character, spaces do not count)', () => {
    expect(CONTENT_MIN_CHARS).toBe(2);
    expect(contentSearchText('a')).toBe('');
    expect(contentSearchText(' a ')).toBe('');
    expect(contentSearchText('ab')).toBe('ab');
    expect(contentSearchText('登')).toBe('');
    expect(contentSearchText('登录')).toBe('登录');
  });

  it('the filter bar starts without archived sessions; only a change from that counts as active', () => {
    expect(PALETTE_DEFAULT_FILTERS.status).toBe('live');
    expect(paletteFiltersActive(PALETTE_DEFAULT_FILTERS)).toBe(false);
    expect(paletteFiltersActive({ ...PALETTE_DEFAULT_FILTERS, status: 'all' })).toBe(true);
    expect(paletteFiltersActive({ ...PALETTE_DEFAULT_FILTERS, machineId: 'm1' })).toBe(true);
  });

  it('「对话内容」 sits right after 「会话」, before terminals / settings / create', () => {
    const order = orderPaletteItems(['create', 'terminals', 'content', 'sessions', 'actions'].map((group) => ({ group: group as PaletteGroup })));
    expect(order.map((it) => it.group)).toEqual(['actions', 'sessions', 'content', 'terminals', 'create']);
  });
});

describe('B-865 highlight when content results arrive', () => {
  it('an unchosen highlight on 「新建对话」 moves to the first result; a chosen one stays', () => {
    const keys = ['content:s:a', CREATE_ROW_KEY];
    expect(adoptFirstResult(keys, { key: CREATE_ROW_KEY, index: 0 }, false)).toEqual({ key: 'content:s:a', index: 0 });
    const chosen = { key: CREATE_ROW_KEY, index: 1 };
    expect(adoptFirstResult(keys, chosen, true)).toBe(chosen);
    const onRow = { key: 'action:x', index: 0 };
    expect(adoptFirstResult(['content:s:a', 'action:x'], onRow, false)).toBe(onRow);
    const alone = { key: CREATE_ROW_KEY, index: 0 };
    expect(adoptFirstResult([CREATE_ROW_KEY], alone, false)).toBe(alone);
  });
});
