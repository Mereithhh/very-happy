import type { ProjectMemberView, ProjectView, TeamState } from '@slopus/happy-wire';
import { groupRowsByWorkspace, type SidebarWorkspaceGroup, type WorkspaceRowLike } from './sidebarWorkspaceGroups';
import { teamHomeDirectory, teamSessionMembership } from './teamNavigation';

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
 * A team stays in one group: an unattached team's rows all follow the team's
 * own repository (B-723; else its first located row's folder — team worktrees
 * are separate directories). B-708: a
 * team with no located row (every member archived → only history links,
 * which carry no machine/folder) has no folder to follow; it and its rows go
 * to the single trailing 团队 group (`teamsGroup`) instead of one invented
 * 「无工作目录」 group per row, each repeating the team header.
 */

export interface ProjectGroup<T> { project: ProjectView; rows: T[]; teams: TeamState[] }
export interface ProjectGrouping<T extends WorkspaceRowLike> {
  projects: ProjectGroup<T>[];
  unassigned: Array<SidebarWorkspaceGroup<T> & { teams: TeamState[] }>;
  /** Unattached teams with no located row (shown once, in a trailing group
   *  under 未归属), with their unlocated rows (history links). */
  teamsGroup: { rows: T[]; teams: TeamState[] } | null;
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

  // 未归属: anchor every unattached team's rows to ONE folder. B-723: that is
  // the team's own repository (`teamHomeDirectory`) on its machine — never a
  // member's worktree, whose UUID path changes with whoever was active last.
  // Only a team with no known home falls back to its first located row's
  // folder; a team with neither has no folder to follow (B-708).
  const anchor = new Map<string, Pick<T, 'key' | 'machineId' | 'workspacePath' | 'machineName'>>();
  const machineNames = new Map<string, string>();
  for (const row of rows) if (row.machineId && row.machineName && !machineNames.has(row.machineId)) machineNames.set(row.machineId, row.machineName);
  for (const row of loose) {
    const team = row.sessionId ? teamOfSession.get(row.sessionId)?.team : undefined;
    if (!team || anchor.has(team.id)) continue;
    const home = teamHomeDirectory(team, teams);
    if (home) anchor.set(team.id, { key: `team-home:${team.id}`, machineId: team.machineId, workspacePath: home, machineName: machineNames.get(team.machineId) });
    else if (row.machineId) anchor.set(team.id, row);
  }
  const unanchored: T[] = [];
  const proxies = loose.flatMap(row => {
    const team = row.sessionId ? teamOfSession.get(row.sessionId)?.team : undefined;
    if (team && !anchor.has(team.id)) { unanchored.push(row); return []; }
    const a = team ? anchor.get(team.id)! : row;
    return [{ key: a.key, sessionId: row.sessionId, machineId: a.machineId, workspacePath: a.workspacePath, machineName: a.machineName ?? row.machineName, row }];
  });
  const unassigned = groupRowsByWorkspace(proxies).map(g => {
    const groupRows = g.rows.map(p => p.row);
    const ids = new Set<string>();
    for (const r of groupRows) { const t = r.sessionId ? teamOfSession.get(r.sessionId)?.team : undefined; if (t && !t.archivedAt && !teamProject.has(t.id)) ids.add(t.id); }
    return { ...g, rows: groupRows, teams: teams.filter(t => ids.has(t.id)) };
  });
  const placed = new Set<string>([...projectGroups.flatMap(g => g.teams.map(t => t.id)), ...unassigned.flatMap(g => g.teams.map(t => t.id))]);
  // B-729: an unanchored row's own team is always nested with it — even when
  // that team also heads another group — or the row shows outside its team.
  const unanchoredTeams = new Set(unanchored.flatMap(r => { const t = r.sessionId ? teamOfSession.get(r.sessionId)?.team : undefined; return t ? [t.id] : []; }));
  const groupTeams = teams.filter(t => !t.archivedAt && (unanchoredTeams.has(t.id) || (!placed.has(t.id) && !teamProject.has(t.id))));
  const teamsGroup = groupTeams.length > 0 || unanchored.length > 0 ? { rows: unanchored, teams: groupTeams } : null;
  return { projects: projectGroups, unassigned, teamsGroup };
}

/**
 * B-756: a session's project outside the project lens (tag / flat / status
 * views), by the same rule as `groupRowsByProject` — explicit membership, else
 * its team's attached project; archived projects count as none.
 */
export function sessionProjectResolver(projects: ProjectView[], members: ProjectMemberView[], teams: TeamState[]): (sessionId: string | undefined) => ProjectView | null {
  const live = projects.filter(p => !p.archivedAt);
  const byId = new Map(live.map(p => [p.id, p]));
  const memberProject = new Map(members.filter(m => byId.has(m.projectId)).map(m => [m.sessionId, m.projectId]));
  const teamProject = new Map<string, string>();
  for (const p of live) for (const teamId of p.teamIds ?? []) teamProject.set(teamId, p.id);
  const teamOfSession = teamSessionMembership(teams);
  return (sessionId) => {
    const pid = projectOfSession(sessionId, memberProject, teamProject, teamOfSession);
    return pid ? byId.get(pid) ?? null : null;
  };
}

export interface ProjectAreaEntry { project: ProjectView; sessions: number; attention: number }
/**
 * B-756: the 「项目」 area on top of the tag lens — one entry per live project
 * (same order as the project lens: first appearance in the ordered list, then
 * the rest oldest first), with its visible session count and 等你处理 count.
 * Sessions themselves stay in their tag groups (with a project chip): moving
 * them here would empty the P0–P2 groups and give a row two ⌘N slots.
 */
export function projectAreaEntries<T extends WorkspaceRowLike & { teamHistoryLink?: boolean }>(
  rows: T[], projects: ProjectView[], members: ProjectMemberView[], teams: TeamState[], attentionKeys: ReadonlySet<string>,
): ProjectAreaEntry[] {
  return groupRowsByProject(rows, projects, members, teams).projects.map(g => {
    const sessions = g.rows.filter(r => !r.teamHistoryLink);
    return { project: g.project, sessions: sessions.length, attention: sessions.filter(r => attentionKeys.has(r.key)).length };
  });
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
 * Grouping settings (B-647, revised by B-675). The lens lives in
 * `sidebarGrouping` ('project' default | 'tag' | 'none'); `sidebarGroupMode` /
 * `sidebarGroupByTag` stay in the schema (add-only), no longer drive the lens,
 * and are mirrored for an old-Web rollback.
 *
 * A device whose legacy fields still say tag never touched the grouping menu
 * since B-647 (picking a lens there rewrites them), so its last explicit
 * choice was tag grouping: it gets the one-time 「按标签分组回来了」 notice.
 */
export type SidebarGrouping = 'project' | 'tag' | 'none';

export function resolveSidebarGrouping(saved: string | undefined): SidebarGrouping {
  return saved === 'tag' || saved === 'none' ? saved : 'project';
}

export function usedTagGrouping(savedGroupMode: string | undefined, legacyGroupByTag: boolean | undefined): boolean {
  return savedGroupMode === 'tag' || legacyGroupByTag === true;
}

/** Show the B-675 notice: pre-B-647 tag user, not on the tag lens, not dismissed. */
export function showTagGroupingBackNotice(prefs: { sidebarGrouping?: string; sidebarGroupMode?: string; sidebarGroupByTag?: boolean; tagGroupingBackNoticeDismissed?: boolean }): boolean {
  return usedTagGrouping(prefs.sidebarGroupMode, prefs.sidebarGroupByTag)
    && resolveSidebarGrouping(prefs.sidebarGrouping) !== 'tag'
    && prefs.tagGroupingBackNoticeDismissed !== true;
}

/** Old-Web rollback keeps something sensible: project ↔ workspace, tag ↔ tag, none ↔ none. */
export function legacyGroupModeFor(grouping: SidebarGrouping): { sidebarGroupMode: 'workspace' | 'tag' | 'none'; sidebarGroupByTag: boolean } {
  return { sidebarGroupMode: grouping === 'project' ? 'workspace' : grouping, sidebarGroupByTag: grouping === 'tag' };
}
