/**
 * sidebarRows — which chat sessions a sidebar view shows. Pure; unit-tested
 * (sidebarRows.test.ts).
 *
 * Extracted from Sidebar.tsx's inline filter after the B-091 leak: the
 * assistant meta-session filter (B-053) lived only in storage.ts's
 * buildSessionListViewData, but the sidebar builds its rows from useSessions
 * (the legacy sessionsData lane) which never passed through it — so the
 * meta-session leaked into the list. The predicate now lives in ONE place
 * (assistant/assistantSession.isAssistantSession) and this function is the
 * sidebar's tested application of it, for the archived view too.
 */
import type { Session } from '@/sync/storageTypes';
import { isAssistantSession } from '@/assistant/assistantSession';

export function visibleSidebarSessions(
  sessions: ReadonlyArray<Session | string>,
  view: 'list' | 'status' | 'archived',
): Session[] {
  return sessions
    .filter((s): s is Session => typeof s !== 'string')
    .filter((s) => !isAssistantSession(s))
    .filter((s) => (view === 'archived' ? !s.active : s.active));
}
