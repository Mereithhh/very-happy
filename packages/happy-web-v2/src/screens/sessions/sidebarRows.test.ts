/**
 * Regression tests for the B-091 assistant meta-session leak: the sidebar
 * builds its rows from useSessions (the legacy sessionsData lane), whose
 * inline filter never excluded `metadata.variant === 'assistant'` — B-053's
 * filter only lived in buildSessionListViewData, which nothing renders.
 * visibleSidebarSessions is the sidebar's tested application of the shared
 * isAssistantSession predicate, archived view included.
 */
import { describe, it, expect } from 'vitest';
import { sidebarListEmpty, visibleSidebarSessions } from './sidebarRows';
import { isAssistantSession, isHiddenSession, isMirrorSession } from '@/assistant/assistantSession';
import type { Session } from '@/sync/storageTypes';
import type { ProjectMemberView, ProjectView, TeamState } from '@slopus/happy-wire';
import { buildSidebarTree } from './sidebarTree';
import { isWaking, WAKE_GRACE_MS } from '@/app/sessionHibernation';

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

/**
 * B-906 (Owner 11-10): opening a hibernated session in a project made it vanish
 * from the sidebar for a few seconds. The wake's first wrapper write
 * (happy-cli `mergeReconnectMetadata`: lifecycleState running, stamp cleared)
 * lands before its first `session-alive`; in between the row was neither
 * active nor hibernated and dropped out of the list (and so out of its group).
 */
describe('B-906 a waking session keeps its place through the whole wake', () => {
  const NOW = 1_800_000_000_000;
  const HIB_AT = NOW - 3 * 3600_000;
  const base = { path: '/w', host: 'h', machineId: 'm', flavor: 'claude', lifecycleState: 'running', lifecycleStateSince: HIB_AT - 86_400_000 };
  /** The three states the web sees, in arrival order. */
  const phases = (id: string) => [
    ['hibernated', mkSession({ id, active: false, activeAt: HIB_AT, metadata: { ...base, hibernation: { at: HIB_AT, seq: 3 } } as Session['metadata'] })],
    ['waking', mkSession({ id, active: false, activeAt: HIB_AT, metadata: { ...base, lifecycleStateSince: NOW - 500 } as Session['metadata'] })],
    ['awake', mkSession({ id, active: true, activeAt: NOW, metadata: { ...base, lifecycleStateSince: NOW - 500 } as Session['metadata'] })],
  ] as const;
  const placeOf = (sessions: Session[], id: string) => {
    const rows = visibleSidebarSessions(sessions, 'list', NOW).map((s) => ({ key: s.id, sessionId: s.id, ts: s.updatedAt }));
    const tree = buildSidebarTree({
      rows,
      projects: [{ id: 'p', name: 'p', folders: [], defaults: {}, archivedAt: null, createdAt: 1, updatedAt: 1, teamIds: ['t'] } as unknown as ProjectView],
      members: [{ projectId: 'p', sessionId: 'proj', via: 'explicit', machineId: null, createdAt: 1 } as ProjectMemberView],
      teams: [{ id: 't', name: 't', machineId: 'm', version: 1, createdAt: 1, tasks: [], messages: [], operations: [], bots: [{ id: 'b', name: 'Lead', sessionId: 'lead', root: true, generation: 1, managed: true, assistant: 'claude', directory: null }] } as unknown as TeamState],
      needsYou: () => false,
    });
    for (const g of [...tree.projects, ...(tree.unassigned ? [tree.unassigned] : [])]) if (g.rows.some((r) => r.key === id)) return g.id;
    return 'MISSING';
  };

  for (const [id, group] of [['proj', 'project:p'], ['lead', 'project:p'], ['loose', 'unassigned']] as const) {
    it(`${id}: ${group} in every phase`, () => {
      const others = ['proj', 'lead', 'loose'].filter((o) => o !== id).map((o) => mkSession({ id: o }));
      expect(phases(id).map(([phase, s]) => [phase, placeOf([s, ...others], id)])).toEqual([
        ['hibernated', group], ['waking', group], ['awake', group],
      ]);
    });
  }

  it('isWaking: only a start newer than the last heartbeat, and only for the grace period', () => {
    const waking = phases('w')[1][1];
    expect(isWaking(waking, NOW)).toBe(true);
    expect(isWaking({ ...waking, active: true }, NOW)).toBe(false);
    expect(isWaking({ ...waking, archivedAt: NOW } as Session, NOW)).toBe(false);
    // a plain offline session: it heartbeat after its wrapper started
    expect(isWaking({ ...waking, activeAt: NOW - 100 }, NOW)).toBe(false);
    // a wrapper that never came up stops counting
    expect(isWaking(waking, NOW - 500 + WAKE_GRACE_MS + 1)).toBe(false);
    expect(isWaking({ ...waking, metadata: { ...base, lifecycleState: 'archived', lifecycleStateSince: NOW - 500 } as Session['metadata'] }, NOW)).toBe(false);
    // the archived view does not take it either
    expect(visibleSidebarSessions([waking], 'archived', NOW)).toEqual([]);
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
