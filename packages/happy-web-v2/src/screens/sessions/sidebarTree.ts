import type { ProjectMemberView, ProjectView, TeamState } from '@slopus/happy-wire';
import { groupRowsByProject, sessionProjectResolver } from './sidebarProjectGroups';
import type { WorkspaceRowLike } from './sidebarWorkspaceGroups';
import { teamSessionMembership, type TeamNavigationEntry } from './teamNavigation';

/**
 * B-762 (B-760 scheme A, spec DESIGN §5): the sidebar as a project tree.
 *
 *   项目 (depth 0)
 *    ├─ 团队 (1)  ── 负责人 / 成员 / 已停用 N 个 (2)
 *    └─ 会话 (1)
 *   不在项目中        ── teams and sessions at depth 0, members at 1
 *
 * Only the 按项目 lens draws the tree; 按标签 and 最近 are session lists with
 * one owner chip per row (`listOwnerChip`), and member conversations join
 * them only while they wait for the user (D3, `listShowsRow`). Everything here
 * is pure; Sidebar.tsx renders it.
 */

/** A project with activity in the last 7 days starts expanded. */
export const TREE_RECENT_MS = 7 * 24 * 3600_000;

/** Device-local fold id of a team in the tree (sidebarCollapsedGroups). */
export function teamTreeGroupId(teamId: string): string {
  return `team:${teamId}`;
}

/** The single bottom area for everything outside a project. */
export const UNASSIGNED_GROUP_ID = 'unassigned';

/**
 * §5.1 default fold: a project is open when something happened in the last
 * 7 days, something waits for the user, or the user is inside it; otherwise
 * folded. A remembered choice (sidebarCollapsedGroups) overrides this.
 */
export function projectDefaultOpen(input: { lastActivity: number; badge: number; current: boolean; now: number }): boolean {
  return input.current || input.badge > 0 || (input.lastActivity > 0 && input.now - input.lastActivity <= TREE_RECENT_MS);
}

/** §5.1: a team starts folded unless its page or one of its conversations is open. */
export function teamDefaultOpen(current: boolean): boolean {
  return current;
}

export interface TreeGroup<T> {
  /** fold id: `project:<id>` or `unassigned` */
  id: string;
  project: ProjectView | null;
  /** this group's rows in list order (team rows included; Sidebar nests them) */
  rows: T[];
  teams: TeamState[];
  /** 需要你: rows waiting for the user or unread (sidebarAttention's two signals) */
  badge: number;
  /** visible conversations (history links excluded) */
  sessions: number;
  /** newest row activity, 0 when none */
  lastActivity: number;
}

export interface SidebarTree<T> {
  projects: TreeGroup<T>[];
  /** 不在项目中 (or 「会话」 for a user without projects); null when empty */
  unassigned: TreeGroup<T> | null;
  /** needs-you count per team, over every member row (folded or not) */
  teamBadges: Map<string, number>;
  /** sum over the project groups — the 「项目」 capability badge (D1) */
  projectBadgeTotal: number;
}

type TreeRow = WorkspaceRowLike & { ts?: number; teamHistoryLink?: boolean };

/**
 * Projects in the project lens's order (first appearance in the ordered list,
 * then the rest oldest first — `groupRowsByProject`), then ONE flat 不在项目中
 * group in list order (D2: no folder sub-groups by default). Teams attached to
 * a project live under it; unattached teams under 不在项目中.
 */
export function buildSidebarTree<T extends TreeRow>(input: {
  rows: T[];
  projects: ProjectView[];
  members: ProjectMemberView[];
  teams: TeamState[];
  needsYou: (row: T) => boolean;
}): SidebarTree<T> {
  const { rows, needsYou } = input;
  const liveTeams = input.teams.filter((t) => !t.archivedAt);
  const grouping = groupRowsByProject(rows, input.projects, input.members, liveTeams);
  const summary = (groupRows: T[]) => {
    const sessions = groupRows.filter((r) => !r.teamHistoryLink);
    return {
      badge: sessions.filter(needsYou).length,
      sessions: sessions.length,
      lastActivity: sessions.reduce((m, r) => Math.max(m, r.ts ?? 0), 0),
    };
  };
  // A project's own edits (name, goal, folders) count as activity too — a new, still empty project starts open.
  const projects: TreeGroup<T>[] = grouping.projects.map((g) => {
    const own = summary(g.rows);
    return { id: `project:${g.project.id}`, project: g.project, rows: g.rows, teams: g.teams, ...own, lastActivity: Math.max(own.lastActivity, g.project.updatedAt ?? 0, g.project.createdAt ?? 0) };
  });
  const inProject = new Set(projects.flatMap((g) => g.rows.map((r) => r.key)));
  const looseRows = rows.filter((r) => !inProject.has(r.key));
  const teamIds = new Set<string>();
  for (const g of grouping.unassigned) for (const t of g.teams) teamIds.add(t.id);
  for (const t of grouping.teamsGroup?.teams ?? []) teamIds.add(t.id);
  const looseTeams = liveTeams.filter((t) => teamIds.has(t.id));
  const unassigned = looseRows.length > 0 || looseTeams.length > 0
    ? { id: UNASSIGNED_GROUP_ID, project: null, rows: looseRows, teams: looseTeams, ...summary(looseRows) }
    : null;
  const membership = teamSessionMembership(liveTeams);
  const teamBadges = new Map<string, number>();
  for (const r of rows) {
    if (r.teamHistoryLink || !r.sessionId || !needsYou(r)) continue;
    const team = membership.get(r.sessionId)?.team;
    if (team) teamBadges.set(team.id, (teamBadges.get(team.id) ?? 0) + 1);
  }
  return { projects, unassigned, teamBadges, projectBadgeTotal: projects.reduce((n, g) => n + g.badge, 0) };
}

/**
 * Depth of each nested entry (`groupTeamNavigation` output) inside a group
 * whose direct children sit at `base` (1 under a project, 0 in 不在项目中):
 * a team and a plain row at `base`, a team's members / fold / hint one deeper.
 */
export function entryDepth<T>(entry: TeamNavigationEntry<T>, base: number): number {
  if (entry.kind === 'team') return base;
  if (entry.kind === 'row') return entry.team ? base + 1 : base;
  return base + 1;
}

/**
 * Inside a tree group the teams come first (each with its members, fold and
 * hint), then the plain sessions — both in list order. Teams are the group's
 * standing units, sessions its loose work (prototype A).
 */
export function teamsFirst<T>(entries: TeamNavigationEntry<T>[]): TeamNavigationEntry<T>[] {
  const teams: TeamNavigationEntry<T>[] = [];
  const plain: TeamNavigationEntry<T>[] = [];
  for (const entry of entries) (entry.kind === 'row' && !entry.team ? plain : teams).push(entry);
  return [...teams, ...plain];
}

/** The role a member row plays in its team: the lead (root bot) or a member. */
export function teamRowRole(bot: { root?: boolean } | undefined): 'lead' | 'member' | undefined {
  if (!bot) return undefined;
  return bot.root ? 'lead' : 'member';
}

/**
 * D3: in 按标签 / 最近, a team member's conversation shows only while it waits
 * for the user; the lead's always does (it is who the user talks to), and so
 * does every ordinary session.
 */
export function listShowsRow(role: 'lead' | 'member' | undefined, waiting: boolean): boolean {
  return role !== 'member' || waiting;
}

/**
 * §5.2: one owner chip per row in the list lenses — the team for a lead or
 * member, else the project, else none.
 */
export function listOwnerChip(input: { teamName?: string; projectName?: string }): { kind: 'team' | 'project'; name: string } | null {
  if (input.teamName) return { kind: 'team', name: input.teamName };
  if (input.projectName) return { kind: 'project', name: input.projectName };
  return null;
}

/** Owner chips for every session of the user's projects and teams (B-756's project resolver + team membership). */
export function ownerChipResolver(projects: ProjectView[], members: ProjectMemberView[], teams: TeamState[]) {
  const live = teams.filter((t) => !t.archivedAt);
  const projectOf = sessionProjectResolver(projects, members, live);
  const membership = teamSessionMembership(live);
  return (sessionId: string | undefined): { chip: ReturnType<typeof listOwnerChip>; role: 'lead' | 'member' | undefined; botName?: string } => {
    if (!sessionId) return { chip: null, role: undefined };
    const member = membership.get(sessionId);
    return {
      chip: listOwnerChip({ teamName: member?.team.name, projectName: projectOf(sessionId)?.name }),
      role: teamRowRole(member?.bot),
      botName: member?.bot.name,
    };
  };
}

export interface TreeKeyItem {
  depth: number;
  /** undefined: a leaf (nothing to fold) */
  expanded?: boolean;
}

/**
 * §5.1 keyboard: ↑/↓ move, → opens a folded node or steps into an open one,
 * ← folds an open node or steps out to its parent. Returns what to do with
 * the item at `index`; null when the key does nothing here.
 */
export function treeKeyAction(items: readonly TreeKeyItem[], index: number, key: string): { focus: number } | { toggle: number } | null {
  const item = items[index];
  if (!item) return null;
  if (key === 'ArrowDown') return index + 1 < items.length ? { focus: index + 1 } : null;
  if (key === 'ArrowUp') return index > 0 ? { focus: index - 1 } : null;
  if (key === 'ArrowRight') {
    if (item.expanded === false) return { toggle: index };
    if (item.expanded === true && items[index + 1] && items[index + 1].depth > item.depth) return { focus: index + 1 };
    return null;
  }
  if (key === 'ArrowLeft') {
    if (item.expanded === true) return { toggle: index };
    for (let j = index - 1; j >= 0; j--) if (items[j].depth < item.depth) return { focus: j };
    return null;
  }
  return null;
}
