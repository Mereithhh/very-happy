import type { ProjectMemberView, ProjectView, TeamState } from '@slopus/happy-wire';
import { teamSessionMembership } from '@/screens/sessions/teamNavigation';

/**
 * B-762 / B-763: where a session sits — the ONE rule shared by the sidebar
 * tree and the page breadcrumbs, so both always show the same path.
 *
 * Spec B-760 §2.1: 项目 ⊃ 团队 ⊃ 成员. A session that belongs to a live team
 * (`teamSessionMembership`) follows its team: its project is the team's live
 * project, or none — its own explicit project membership is ignored (Lead
 * 10-22), so a member never shows outside its team. Any other session is in
 * the live project it was explicitly put in, else none. Archived projects and
 * teams count as none.
 *
 * Not the same as `sessionProjectResolver` (sidebarProjectGroups.ts, explicit
 * membership first), which stays for its existing callers.
 */
export interface SessionPlacement {
  projectId: string | null;
  teamId?: string;
}

export function sessionPlacementResolver(projects: ProjectView[], members: ProjectMemberView[], teams: TeamState[]): (sessionId: string | undefined) => SessionPlacement {
  const live = new Set(projects.filter((p) => !p.archivedAt).map((p) => p.id));
  const explicit = new Map(members.filter((m) => live.has(m.projectId)).map((m) => [m.sessionId, m.projectId]));
  const teamProject = new Map<string, string>();
  for (const p of projects) if (live.has(p.id)) for (const teamId of p.teamIds ?? []) teamProject.set(teamId, p.id);
  const membership = teamSessionMembership(teams.filter((t) => !t.archivedAt));
  return (sessionId) => {
    if (!sessionId) return { projectId: null };
    const team = membership.get(sessionId)?.team;
    if (team) return { projectId: teamProject.get(team.id) ?? null, teamId: team.id };
    return { projectId: explicit.get(sessionId) ?? null };
  };
}

/** One-off form of `sessionPlacementResolver` (build the resolver once when placing many sessions). */
export function resolveSessionPlacement(sessionId: string | undefined, ctx: { projects: ProjectView[]; members: ProjectMemberView[]; teams: TeamState[] }): SessionPlacement {
  return sessionPlacementResolver(ctx.projects, ctx.members, ctx.teams)(sessionId);
}
