import type { ProjectMemberView } from '@slopus/happy-wire';

/**
 * B-649: what 「移到项目…」 has to do. Joining a project is a server-side move
 * (a session belongs to at most one project), so only 无项目 needs explicit
 * removals — and only for explicit memberships (a team-derived member leaves
 * when its team is detached, not here).
 */
export function planMove(sessionIds: string[], target: string | null, members: ProjectMemberView[]): {
  add: { projectId: string; sessionIds: string[] } | null;
  remove: { projectId: string; sessionId: string }[];
} {
  const unique = [...new Set(sessionIds)];
  if (target) {
    const moving = unique.filter((id) => members.find((m) => m.sessionId === id)?.projectId !== target);
    return { add: moving.length ? { projectId: target, sessionIds: moving } : null, remove: [] };
  }
  const remove = unique.flatMap((id) => {
    const m = members.find((x) => x.sessionId === id);
    return m && m.via !== 'team' ? [{ projectId: m.projectId, sessionId: id }] : [];
  });
  return { add: null, remove };
}
