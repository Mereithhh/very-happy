/**
 * Regression tests for the B-091 assistant meta-session leak: the sidebar
 * builds its rows from useSessions (the legacy sessionsData lane), whose
 * inline filter never excluded `metadata.variant === 'assistant'` — B-053's
 * filter only lived in buildSessionListViewData, which nothing renders.
 * visibleSidebarSessions is the sidebar's tested application of the shared
 * isAssistantSession predicate, archived view included.
 */
import { describe, it, expect } from 'vitest';
import { flatListRows, sidebarListEmpty, visibleSidebarSessions } from './sidebarRows';
import { readFileSync } from 'node:fs';
import { groupTeamNavigation } from './teamNavigation';
import type { TeamState } from '@slopus/happy-wire';
import { isAssistantSession, isHiddenSession, isMirrorSession } from '@/assistant/assistantSession';
import type { Session } from '@/sync/storageTypes';

function mkSession(over: Partial<Session> & { id: string }): Session {
  return {
    seq: 0,
    createdAt: 1,
    updatedAt: 2,
    active: true,
    activeAt: 2,
    metadata: { path: '/p', host: 'h' } as Session['metadata'],
    metadataVersion: 0,
    agentState: null,
    agentStateVersion: 0,
    thinking: false,
    thinkingAt: 0,
    presence: 'online',
    ...over,
  } as Session;
}

const normal = mkSession({ id: 'normal' });
const archived = mkSession({ id: 'archived', active: false });
const assistant = mkSession({
  id: 'assistant',
  metadata: { path: '/p', host: 'h', variant: 'assistant' } as Session['metadata'],
});
const assistantArchived = mkSession({
  id: 'assistant-archived',
  active: false,
  metadata: { path: '/p', host: 'h', variant: 'assistant' } as Session['metadata'],
});

const mirror = mkSession({
  id: 'mirror',
  metadata: { path: '/p', host: 'h', flavor: 'terminal-mirror', terminalId: 'tid1' } as Session['metadata'],
});
const mirrorArchived = mkSession({
  id: 'mirror-archived',
  active: false,
  metadata: { path: '/p', host: 'h', flavor: 'terminal-mirror' } as Session['metadata'],
});

describe('isAssistantSession', () => {
  it('matches exactly the assistant variant', () => {
    expect(isAssistantSession(assistant)).toBe(true);
    expect(isAssistantSession(normal)).toBe(false);
    expect(isAssistantSession(mkSession({ id: 'x', metadata: undefined as never }))).toBe(false);
  });
});

describe('isMirrorSession / isHiddenSession (B-105)', () => {
  it('mirror matches exactly the terminal-mirror flavor', () => {
    expect(isMirrorSession(mirror)).toBe(true);
    expect(isMirrorSession(normal)).toBe(false);
    expect(isMirrorSession(assistant)).toBe(false);
    expect(isMirrorSession(mkSession({ id: 'x', metadata: undefined as never }))).toBe(false);
  });

  it('hidden = assistant ∪ mirror, and nothing else', () => {
    expect(isHiddenSession(assistant)).toBe(true);
    expect(isHiddenSession(mirror)).toBe(true);
    expect(isHiddenSession(normal)).toBe(false);
    // other flavors stay visible — only the exact mirror flavor hides
    expect(
      isHiddenSession(mkSession({
        id: 'codex',
        metadata: { path: '/p', host: 'h', flavor: 'codex' } as Session['metadata'],
      })),
    ).toBe(false);
  });
});

describe('visibleSidebarSessions', () => {
  const all = [normal, archived, assistant, assistantArchived, mirror, mirrorArchived, 'Today'];

  it('列表/状态 (active set): hidden sessions (assistant + mirror) never appear — THE leak', () => {
    for (const view of ['list', 'status'] as const) {
      expect(visibleSidebarSessions(all, view).map((s) => s.id)).toEqual(['normal']);
    }
  });

  it('归档 view filters them too (and shows only inactive sessions)', () => {
    expect(visibleSidebarSessions(all, 'archived').map((s) => s.id)).toEqual(['archived']);
  });

  it('drops legacy group-header strings', () => {
    expect(visibleSidebarSessions(['online', normal], 'list')).toEqual([normal]);
  });
});

describe('B-587 hibernated sessions stay in the working list', () => {
  it('list/status keep a hibernated row; archived view does not take it', async () => {
    const { visibleSidebarSessions } = await import('./sidebarRows');
    const hib = { id: 'h', active: false, archivedAt: null, activeAt: 1, metadata: { path: '/', host: 'h', hibernation: { at: 1, seq: 1 } } } as never;
    const off = { id: 'o', active: false, archivedAt: null, activeAt: 1, metadata: { path: '/', host: 'h' } } as never;
    expect(visibleSidebarSessions([hib, off], 'list').map((s) => s.id)).toEqual(['h']);
    expect(visibleSidebarSessions([hib, off], 'archived').map((s) => s.id)).toEqual(['o']);
  });
});

describe('sidebarListEmpty (B-708)', () => {
  it('a team whose members are all archived (count 0, header row present) is not an empty list', () => {
    expect(sidebarListEmpty([{ count: 0, allRows: [] }, { count: 0, allRows: [{ key: 'team:t' }] }], 0)).toBe(false);
  });
  it('no rows anywhere and nothing closed → empty; a project group or closed rows keep it non-empty', () => {
    expect(sidebarListEmpty([{ count: 0, allRows: [] }], 0)).toBe(true);
    expect(sidebarListEmpty([{ count: 0, allRows: [], project: {} }], 0)).toBe(false);
    expect(sidebarListEmpty([{ count: 0, allRows: [] }], 2)).toBe(false);
  });
});

describe('flat list keeps the inactive-members fold (B-710)', () => {
  const team = { id: 't', name: 't', machineId: 'm', version: 1, tasks: [], messages: [], operations: [], createdAt: 1,
    bots: ['lead', 'ui', 'tests'].map((s, i) => ({ id: `b${i}`, name: s, sessionId: s, generation: 1, root: i === 0, managed: true, assistant: 'claude', directory: null })) } as unknown as TeamState;
  // Same shape Sidebar's nestTeams maps entries to: the fold becomes a row carrying teamInactiveFold.
  const nested = (open: boolean) => groupTeamNavigation([{ sessionId: 'lead' }, { sessionId: 'ui' }, { sessionId: 'x' }], [team], new Set(['t']), {
    isInactive: (r) => r.sessionId === 'ui', open: new Set(open ? ['t'] : []),
  }).map((e) => e.kind === 'inactive' ? { key: 'fold', teamInactiveFold: { count: e.count, open: e.open } } : e.kind === 'team' ? { key: 'team' } : { key: e.row.sessionId! });
  it('collapsed by default: the fold row is rendered, the inactive member is not, and the fold takes no ⌘N slot', () => {
    const { rendered, sequence } = flatListRows(nested(false));
    expect(rendered.map((r) => r.key)).toEqual(['team', 'lead', 'fold', 'x']);
    expect(sequence.map((r) => r.key)).toEqual(['team', 'lead', 'x']);
  });
  it('opened (device-local choice): the inactive member shows behind the fold', () => {
    expect(flatListRows(nested(true)).rendered.map((r) => r.key)).toEqual(['team', 'lead', 'fold', 'ui', 'x']);
  });
  it('Sidebar renders the flat section from the rendered rows, numbers it from the sequence', () => {
    const src = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8');
    const flat = src.slice(src.indexOf("id: 'all',"), src.indexOf("id: 'all',") + 300);
    expect(flat).toContain('rows: flatRows?.rendered ?? []');
    expect(flat).toContain('allRows: flatRows?.rendered ?? []');
    expect(src).toContain('const displayRows = flatRows?.sequence ?? null;');
  });
});
