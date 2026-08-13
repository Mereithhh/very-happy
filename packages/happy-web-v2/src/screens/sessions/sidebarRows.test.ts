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
import { isAssistantSession } from '@/assistant/assistantSession';
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

describe('isAssistantSession', () => {
  it('matches exactly the assistant variant', () => {
    expect(isAssistantSession(assistant)).toBe(true);
    expect(isAssistantSession(normal)).toBe(false);
    expect(isAssistantSession(mkSession({ id: 'x', metadata: undefined as never }))).toBe(false);
  });
});

describe('visibleSidebarSessions', () => {
  const all = [normal, archived, assistant, assistantArchived, 'Today'];

  it('列表/状态 (active set): assistant meta-session never appears — THE leak', () => {
    for (const view of ['list', 'status'] as const) {
      expect(visibleSidebarSessions(all, view).map((s) => s.id)).toEqual(['normal']);
    }
  });

  it('归档 view filters it too (and shows only inactive sessions)', () => {
    expect(visibleSidebarSessions(all, 'archived').map((s) => s.id)).toEqual(['archived']);
  });

  it('drops legacy group-header strings', () => {
    expect(visibleSidebarSessions(['online', normal], 'list')).toEqual([normal]);
  });
});
