/**
 * Regression tests for the B-091 assistant meta-session leak: the sidebar
 * builds its rows from useSessions (the legacy sessionsData lane), whose
 * inline filter never excluded `metadata.variant === 'assistant'` — B-053's
 * filter only lived in buildSessionListViewData, which nothing renders.
 * visibleSidebarSessions is the sidebar's tested application of the shared
 * isAssistantSession predicate, archived view included.
 */
import { describe, it, expect } from 'vitest';
import { visibleSidebarSessions } from './sidebarRows';
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
