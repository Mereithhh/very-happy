import type { ProjectMemberView, ProjectView, TeamProjectChoice, TeamState } from '@slopus/happy-wire';

/**
 * B-726 (`specs/2026-10-team-project.md`): pure helpers behind the project
 * picker and the team ↔ project entry points.
 */
export type ProjectChoice = { kind: 'new' } | { kind: 'existing'; projectId: string } | { kind: 'none' };

export function pickerLabel(value: ProjectChoice, projects: Pick<ProjectView, 'id' | 'name'>[], opts: { zh: boolean; newName?: string; none: string }): string {
  if (value.kind === 'none') return opts.none;
  if (value.kind === 'new') {
    const name = opts.newName?.trim();
    return opts.zh ? `新建同名项目${name ? `「${name}」` : ''}` : `New project${name ? ` "${name}"` : ' with the same name'}`;
  }
  return projects.find((p) => p.id === value.projectId)?.name ?? (opts.zh ? '（已不可用的项目）' : '(unavailable project)');
}

/** What a new team sends as `project` (absent = no project, the old request shape). */
export function teamProjectFromChoice(choice: ProjectChoice): TeamProjectChoice | undefined {
  if (choice.kind === 'new') return { create: true };
  if (choice.kind === 'existing') return { projectId: choice.projectId };
  return undefined;
}

/**
 * A team's project, from the shared projects snapshot (`ProjectView.teamIds`,
 * refreshed after every bind) — not `team.projectId`, which is only as fresh
 * as the last team read.
 */
export function projectOfTeam(team: Pick<TeamState, 'id'>, projects: ProjectView[]): ProjectView | null {
  return projects.find((p) => p.teamIds.includes(team.id)) ?? null;
}

/**
 * The project a session is in and whether it can leave it here. A team member
 * (`via: team`) follows its team: it leaves by detaching the team (or by an
 * explicit move into another project, which wins over the team).
 */
export function sessionProject(sessionId: string, members: ProjectMemberView[], projects: ProjectView[]): {
  project: ProjectView | null; via: string | null; teamId: string | null; canLeave: boolean;
} {
  const m = members.find((x) => x.sessionId === sessionId);
  const project = m ? projects.find((p) => p.id === m.projectId) ?? null : null;
  return { project, via: m?.via ?? null, teamId: m?.teamId ?? null, canLeave: !!m && m.via !== 'team' };
}

/** Teams that can be linked to `projectId` from the project page: live, and not already in it. */
export function linkableTeams<T extends Pick<TeamState, 'id' | 'archivedAt'>>(teams: T[], projectId: string, projects: ProjectView[]): T[] {
  return teams.filter((t) => t.archivedAt === undefined && projectOfTeam(t, projects)?.id !== projectId);
}

/**
 * Session header menu entries (B-726): 「移到项目…」(or 「换项目…」 when it is in one)
 * and 「从「X」移出」 for an explicit member. Nothing for a shared-with-me session
 * or while projects are unavailable.
 */
export function sessionProjectMenu(sessionId: string, snap: { status: string; members: ProjectMemberView[]; projects: ProjectView[] }, opts: { shared: boolean; zh: boolean }): {
  move: string | null; leave: { projectId: string; label: string } | null;
} {
  if (opts.shared || snap.status !== 'ready') return { move: null, leave: null };
  const { project, canLeave } = sessionProject(sessionId, snap.members, snap.projects);
  const move = project ? (opts.zh ? '换项目…' : 'Move to another project…') : (opts.zh ? '移到项目…' : 'Move to project…');
  const leave = project && canLeave ? { projectId: project.id, label: opts.zh ? `从「${project.name}」移出` : `Remove from "${project.name}"` } : null;
  return { move, leave };
}
