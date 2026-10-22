import type { ProjectMemberView, ProjectView, TeamState } from '@slopus/happy-wire';
import { sessionProjectResolver } from '@/screens/sessions/sidebarProjectGroups';
import { teamRowTarget, teamSessionMembership } from '@/screens/sessions/teamNavigation';
import { projectPath } from '@/screens/projects/projectMenu';

/**
 * B-763 (B-760 方案 A-3「位置感」): where a page sits in 项目 › 团队 › 成员.
 * The trail is the ancestors of the current page; the current page renders
 * itself (the session title stays the rename button). Placement follows the
 * sidebar's own rules — `sessionProjectResolver` (explicit membership, else the
 * team's project) and `teamSessionMembership` — so the header and the tree
 * always agree on where a conversation lives.
 */
export type TrailKind = 'projects' | 'teams' | 'project' | 'team';
export interface TrailSegment { kind: TrailKind; label: string; href: string }

export interface TrailCopy { projects: string; teams: string }
export function trailCopy(zh: boolean): TrailCopy & { label: string } {
  return zh ? { projects: '项目', teams: '团队', label: '位置' } : { projects: 'Projects', teams: 'Teams', label: 'Location' };
}

type ProjectsSnap = { projects: ProjectView[]; members: ProjectMemberView[] };

/** A session: its project (if any) › its team (if a member). `member` names the
 *  bot so the current segment can read 「后端-1 · 任务」 like the tree row. */
export function sessionTrail(sessionId: string, snap: ProjectsSnap, teams: TeamState[]): {
  ancestors: TrailSegment[]; member: { name: string; lead: boolean } | null;
} {
  const project = sessionProjectResolver(snap.projects, snap.members, teams)(sessionId);
  const membership = teamSessionMembership(teams).get(sessionId);
  const ancestors: TrailSegment[] = [];
  if (project) ancestors.push({ kind: 'project', label: project.name, href: projectPath(project.id) });
  if (membership) ancestors.push({ kind: 'team', label: membership.team.name, href: teamRowTarget(membership.team).href });
  return { ancestors, member: membership ? { name: membership.bot.name, lead: !!membership.bot.root } : null };
}

/** A team page: its project, or the Teams list for a team in no project. */
export function teamTrail(team: Pick<TeamState, 'id'>, projects: ProjectView[], copy: TrailCopy): TrailSegment[] {
  const project = projects.find((p) => !p.archivedAt && p.teamIds.includes(team.id));
  return project ? [{ kind: 'project', label: project.name, href: projectPath(project.id) }] : [{ kind: 'teams', label: copy.teams, href: '/teams' }];
}

/** A project page: the Projects list. */
export function projectTrail(copy: TrailCopy): TrailSegment[] {
  return [{ kind: 'projects', label: copy.projects, href: '/projects' }];
}

/** Phones show only 上一级 › 当前 (DESIGN §5.3); desktop shows the full path. */
export function visibleTrail(ancestors: TrailSegment[], compact: boolean): TrailSegment[] {
  return compact ? ancestors.slice(-1) : ancestors;
}
