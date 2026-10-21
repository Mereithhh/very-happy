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
import { isHiddenSession } from '@/assistant/assistantSession';
import { isHibernated } from '@/app/sessionHibernation';

export function visibleSidebarSessions(
  sessions: ReadonlyArray<Session | string>,
  view: 'list' | 'status' | 'archived',
): Session[] {
  return sessions
    .filter((s): s is Session => typeof s !== 'string')
    .filter((s) => !isHiddenSession(s))
    // B-587: a hibernated session is still a working conversation — it stays
    // in the list (moon in the status slot) instead of dropping into Archived.
    .filter((s) => {
      const live = s.active || isHibernated(s);
      return view === 'archived' ? !live : live;
    });
}

/**
 * B-708: the 「暂无会话」 empty state. A section's `count` excludes team
 * history links (archived members) by design, so a team whose members are all
 * archived counts 0 — but its header row is still there and must stay
 * reachable; only a list with no row at all is empty.
 */
export function sidebarListEmpty(sections: ReadonlyArray<{ count: number; allRows: readonly unknown[]; project?: unknown }>, closedRows: number): boolean {
  return closedRows === 0 && sections.every((sec) => sec.count === 0 && sec.allRows.length === 0 && !sec.project);
}
