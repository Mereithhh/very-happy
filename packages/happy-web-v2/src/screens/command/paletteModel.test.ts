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
  type PaletteGroup,
} from './paletteModel';

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

type Row = { key: string; group: PaletteGroup; haystack: string; tags?: string[] };
const rows: Row[] = [
  { key: 'a:new', group: 'actions', haystack: 'new chat' },
  { key: 'a:hist', group: 'actions', haystack: 'search history full text 搜索历史对话…' },
  { key: 's:1', group: 'sessions', haystack: 'fix login bug ~/proj', tags: ['p0', 'web'] },
  { key: 's:2', group: 'sessions', haystack: 'chat about release' },
  { key: 't:1', group: 'terminals', haystack: 'build server devbox', tags: ['web'] },
];

describe('filterPaletteItems', () => {
  it('returns everything for an empty query', () => {
    expect(filterPaletteItems(rows, '   ')).toBe(rows);
  });
  it('substring match ranked by position, ties by group', () => {
    expect(filterPaletteItems(rows, 'chat').map((r) => r.key)).toEqual(['s:2', 'a:new']);
  });
  it('#tag terms AND-filter on tags; untagged rows fail', () => {
    expect(filterPaletteItems(rows, '#web').map((r) => r.key)).toEqual(['s:1', 't:1']);
    expect(filterPaletteItems(rows, '#web build').map((r) => r.key)).toEqual(['t:1']);
  });
  it('keeps the B-549 search-history action reachable', () => {
    expect(filterPaletteItems(rows, 'history').map((r) => r.key)).toEqual(['a:hist']);
  });
});

describe('orderPaletteItems', () => {
  it('regroups into display order, stable inside a group', () => {
    const mixed: Row[] = [
      { key: 'create', group: 'create', haystack: '' },
      { key: 's:2', group: 'sessions', haystack: '' },
      { key: 'a:1', group: 'actions', haystack: '' },
      { key: 'n:1', group: 'needsYou', haystack: '' },
      { key: 's:1', group: 'sessions', haystack: '' },
      { key: 't:1', group: 'terminals', haystack: '' },
    ];
    expect(orderPaletteItems(mixed).map((r) => r.key)).toEqual(['n:1', 'a:1', 's:2', 's:1', 't:1', 'create']);
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
