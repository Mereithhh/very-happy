import type { ProjectMemberView, ProjectView, TeamState } from '@slopus/happy-wire';
import { groupRowsByWorkspace, type SidebarWorkspaceGroup, type WorkspaceRowLike } from './sidebarWorkspaceGroups';
import { teamSessionMembership } from './teamNavigation';

/**
 * B-647: the default sidebar lens — sessions grouped by project
 * (`specs/2026-10-projects.md` §6.1). A session's project is its explicit
 * membership, else the project its team is attached to. Everything else goes
 * to 「未归属」, sub-grouped by folder exactly like the old workspace lens, so
 * a user with no projects sees the same shape as before (never an empty list).
 *
 * Order rule (same as the other lenses): first appearance in the already
 * ordered list decides group order and row order; projects with no visible
 * row follow, oldest first, so a freshly created project is still reachable.
 * A team stays in one group: an unattached team's rows all follow its first
 * row's folder (team worktrees are separate directories).
 */

export interface ProjectGroup<T> { project: ProjectView; rows: T[]; teams: TeamState[] }
export interface ProjectGrouping<T extends WorkspaceRowLike> {
  projects: ProjectGroup<T>[];
  unassigned: Array<SidebarWorkspaceGroup<T> & { teams: TeamState[] }>;
  /** Unattached teams with no visible row anywhere (shown under 未归属). */
  orphanTeams: TeamState[];
}

export function projectOfSession(
  sessionId: string | undefined,
  memberProject: ReadonlyMap<string, string>,
  teamProject: ReadonlyMap<string, string>,
  teamOfSession: ReadonlyMap<string, { team: TeamState }>,
): string | null {
  if (!sessionId) return null;
  const explicit = memberProject.get(sessionId);
  if (explicit) return explicit;
  const team = teamOfSession.get(sessionId)?.team;
  return team ? teamProject.get(team.id) ?? null : null;
}

export function groupRowsByProject<T extends WorkspaceRowLike>(
  rows: T[],
  projects: ProjectView[],
  members: ProjectMemberView[],
  teams: TeamState[],
): ProjectGrouping<T> {
  const live = projects.filter(p => !p.archivedAt);
  const known = new Set(live.map(p => p.id));
  const memberProject = new Map(members.filter(m => known.has(m.projectId)).map(m => [m.sessionId, m.projectId]));
  const teamProject = new Map<string, string>();
  for (const p of live) for (const teamId of p.teamIds ?? []) teamProject.set(teamId, p.id);
  const teamOfSession = teamSessionMembership(teams);

  const byProject = new Map<string, T[]>();
  const loose: T[] = [];
  for (const row of rows) {
    const pid = projectOfSession(row.sessionId, memberProject, teamProject, teamOfSession);
    if (pid) byProject.set(pid, [...(byProject.get(pid) ?? []), row]);
    else loose.push(row);
  }
  const projectById = new Map(live.map(p => [p.id, p]));
  const ordered = [...byProject.keys()].map(id => projectById.get(id)!);
  const rest = live.filter(p => !byProject.has(p.id)).sort((a, b) => a.createdAt - b.createdAt);
  const teamsOf = (projectId: string, groupRows: T[]) => {
    const ids = new Set<string>();
    for (const t of teams) if (!t.archivedAt && teamProject.get(t.id) === projectId) ids.add(t.id);
    for (const r of groupRows) { const t = r.sessionId ? teamOfSession.get(r.sessionId)?.team : undefined; if (t && !t.archivedAt) ids.add(t.id); }
    return teams.filter(t => ids.has(t.id));
  };
  const projectGroups = [...ordered, ...rest].map(project => {
    const groupRows = byProject.get(project.id) ?? [];
    return { project, rows: groupRows, teams: teamsOf(project.id, groupRows) };
  });

  // 未归属: anchor every unattached team's rows to its first row's folder.
  const anchor = new Map<string, T>();
  for (const row of loose) {
    const team = row.sessionId ? teamOfSession.get(row.sessionId)?.team : undefined;
    if (team && !anchor.has(team.id)) anchor.set(team.id, row);
  }
  const proxies = loose.map(row => {
    const team = row.sessionId ? teamOfSession.get(row.sessionId)?.team : undefined;
    const a = team ? anchor.get(team.id)! : row;
    return { key: row.key, sessionId: row.sessionId, machineId: a.machineId, workspacePath: a.workspacePath, machineName: a.machineName ?? row.machineName, row };
  });
  const unassigned = groupRowsByWorkspace(proxies).map(g => {
    const groupRows = g.rows.map(p => p.row);
    const ids = new Set<string>();
    for (const r of groupRows) { const t = r.sessionId ? teamOfSession.get(r.sessionId)?.team : undefined; if (t && !t.archivedAt && !teamProject.has(t.id)) ids.add(t.id); }
    return { ...g, rows: groupRows, teams: teams.filter(t => ids.has(t.id)) };
  });
  const placed = new Set<string>([...projectGroups.flatMap(g => g.teams.map(t => t.id)), ...unassigned.flatMap(g => g.teams.map(t => t.id))]);
  const orphanTeams = teams.filter(t => !t.archivedAt && !placed.has(t.id) && !teamProject.has(t.id));
  return { projects: projectGroups, unassigned, orphanTeams };
}

/** Folders a converted group brings along (one per machine + path, ≤20). */
export function foldersOfRows(rows: WorkspaceRowLike[]): { machineId: string; path: string }[] {
  const seen = new Set<string>();
  const out: { machineId: string; path: string }[] = [];
  for (const r of rows) {
    if (!r.machineId || !r.workspacePath) continue;
    const key = `${r.machineId}\0${r.workspacePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ machineId: r.machineId, path: r.workspacePath });
    if (out.length === 20) break;
  }
  return out;
}

/**
 * B-647 settings migration. Grouping now lives in `sidebarGrouping`
 * ('project' default | 'none'); `sidebarGroupMode` / `sidebarGroupByTag` stay
 * in the schema (add-only) but no longer drive the lens. A device that had
 * picked tag grouping gets the one-time 「标签分组已合并到项目」 notice.
 */
export function usedTagGrouping(savedGroupMode: string | undefined, legacyGroupByTag: boolean | undefined): boolean {
  return savedGroupMode === 'tag' || legacyGroupByTag === true;
}

/** Old-Web rollback keeps something sensible: project ↔ workspace, none ↔ none. */
export function legacyGroupModeFor(grouping: 'project' | 'none'): 'workspace' | 'none' {
  return grouping === 'project' ? 'workspace' : 'none';
}

/** First-tag buckets the tag→project action offers, most used first. */
export function tagCandidates(rows: { tags?: string[] }[]): { tag: string; count: number }[] {
  const counts = new Map<string, { tag: string; count: number }>();
  for (const r of rows) {
    const tag = r.tags?.[0]?.trim();
    if (!tag) continue;
    const k = tag.toLowerCase();
    const c = counts.get(k) ?? { tag, count: 0 };
    c.count++;
    counts.set(k, c);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
