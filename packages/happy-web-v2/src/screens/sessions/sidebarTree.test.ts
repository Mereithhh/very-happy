/**
 * B-762 (spec B-760 §5): the pure tree model behind the 按项目 lens and the
 * list-lens rules (D1–D3). Rendering is covered by SidebarTree.test.tsx.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectMemberView, ProjectView, TeamState } from '@slopus/happy-wire';
import {
  buildSidebarTree, entryDepth, listOwnerChip, listShowsRow, ownerChipResolver, projectDefaultOpen, teamDefaultOpen,
  teamRowRole, teamsFirst, teamTreeGroupId, treeKeyAction, TREE_RECENT_MS, UNASSIGNED_GROUP_ID,
} from './sidebarTree';
import { groupTeamNavigation } from './teamNavigation';

const NOW = 1_800_000_000_000;
type R = { key: string; sessionId?: string; machineId?: string; workspacePath?: string; ts?: number; teamHistoryLink?: boolean };
const row = (id: string, ts = NOW): R => ({ key: id, sessionId: id, machineId: 'm', workspacePath: '/w', ts });
const project = (id: string, extra: Partial<ProjectView> = {}): ProjectView => ({ id, name: id, goal: null, instructions: '', instructionsVersion: 0, instructionsUpdatedBy: null, instructionsUpdatedAt: null, folders: [], defaults: {}, archivedAt: null, createdAt: 1, updatedAt: 1, teamIds: [], automationIds: [], ...extra }) as unknown as ProjectView;
const member = (projectId: string, sessionId: string): ProjectMemberView => ({ projectId, sessionId, via: 'explicit', machineId: null, createdAt: 1 }) as ProjectMemberView;
const team = (id: string, sessions: string[], extra: Partial<TeamState> = {}): TeamState => ({
  id, name: id, machineId: 'm', version: 1, createdAt: 1, tasks: [], messages: [], operations: [],
  bots: sessions.map((sessionId, i) => ({ id: `${id}-b${i}`, name: i === 0 ? 'Lead' : `M${i}`, sessionId, root: i === 0, generation: 1, managed: true, assistant: 'claude', directory: null })),
  ...extra,
}) as TeamState;

describe('buildSidebarTree', () => {
  it('full: projects (with their attached team and member sessions) then ONE flat 不在项目中 group', () => {
    const t1 = team('t1', ['lead', 'fe']);
    const loose = team('t2', ['l2']);
    const rows = [row('lead'), row('fe'), row('a'), row('b'), row('l2'), row('x')];
    const tree = buildSidebarTree({
      rows, teams: [t1, loose],
      projects: [project('p', { teamIds: ['t1'] }), project('empty', { createdAt: 5 })],
      members: [member('p', 'a')],
      needsYou: (r) => r.key === 'fe' || r.key === 'a',
    });
    expect(tree.projects.map((g) => [g.id, g.rows.map((r) => r.key), g.teams.map((t) => t.id), g.badge, g.sessions])).toEqual([
      ['project:p', ['lead', 'fe', 'a'], ['t1'], 2, 3],
      ['project:empty', [], [], 0, 0],
    ]);
    // D2: no folder sub-groups — the loose rows stay one flat list in list order.
    expect(tree.unassigned!.id).toBe(UNASSIGNED_GROUP_ID);
    expect(tree.unassigned!.rows.map((r) => r.key)).toEqual(['b', 'l2', 'x']);
    expect(tree.unassigned!.teams.map((t) => t.id)).toEqual(['t2']);
    expect(Object.fromEntries(tree.teamBadges)).toEqual({ t1: 1 });
    expect(tree.projectBadgeTotal).toBe(2);
  });

  it('only sessions: no project group, everything in 不在项目中', () => {
    const tree = buildSidebarTree({ rows: [row('a'), row('b')], teams: [], projects: [], members: [], needsYou: () => true });
    expect(tree.projects).toEqual([]);
    expect(tree.unassigned!.rows.map((r) => r.key)).toEqual(['a', 'b']);
    expect(tree.unassigned!.badge).toBe(2);
    expect(tree.projectBadgeTotal).toBe(0);
  });

  it('new user: nothing at all', () => {
    const tree = buildSidebarTree({ rows: [], teams: [], projects: [], members: [], needsYou: () => false });
    expect(tree.projects).toEqual([]);
    expect(tree.unassigned).toBeNull();
  });

  it('a project with no row still counts its own edits as activity; history links never count as sessions or badges', () => {
    const t1 = team('t1', ['lead', 'old']);
    const tree = buildSidebarTree({
      rows: [row('lead', NOW - 10), { ...row('old', 0), teamHistoryLink: true }],
      teams: [t1], projects: [project('p', { teamIds: ['t1'], updatedAt: NOW - 5 }), project('q', { updatedAt: NOW - 3 })], members: [],
      needsYou: () => true,
    });
    expect(tree.projects.map((g) => [g.id, g.sessions, g.badge, g.lastActivity])).toEqual([['project:p', 1, 1, NOW - 5], ['project:q', 0, 0, NOW - 3]]);
    expect(Object.fromEntries(tree.teamBadges)).toEqual({ t1: 1 });
  });

  it('archived teams and archived projects drop out', () => {
    const tree = buildSidebarTree({
      rows: [row('lead'), row('a')], teams: [team('t1', ['lead'], { archivedAt: 3 } as Partial<TeamState>)],
      projects: [project('gone', { archivedAt: 2 } as Partial<ProjectView>)], members: [member('gone', 'a')], needsYou: () => false,
    });
    expect(tree.projects).toEqual([]);
    expect(tree.unassigned!.teams).toEqual([]);
    expect(tree.unassigned!.rows.map((r) => r.key)).toEqual(['lead', 'a']);
  });
});

describe('default folds (§5.1)', () => {
  it('a project opens on recent activity, something needing you, or being current — else folded', () => {
    const base = { lastActivity: NOW - TREE_RECENT_MS - 1, badge: 0, current: false, now: NOW };
    expect(projectDefaultOpen(base)).toBe(false);
    expect(projectDefaultOpen({ ...base, lastActivity: NOW - TREE_RECENT_MS })).toBe(true);
    expect(projectDefaultOpen({ ...base, badge: 1 })).toBe(true);
    expect(projectDefaultOpen({ ...base, current: true })).toBe(true);
    expect(projectDefaultOpen({ ...base, lastActivity: 0 })).toBe(false);
  });
  it('a team opens only while current; its fold id is device-local `team:<id>`', () => {
    expect(teamDefaultOpen(false)).toBe(false);
    expect(teamDefaultOpen(true)).toBe(true);
    expect(teamTreeGroupId('t1')).toBe('team:t1');
  });
});

describe('depth and order', () => {
  const t1 = team('t1', ['lead', 'fe']);
  const entries = groupTeamNavigation([row('s1'), row('lead'), row('fe'), row('s2')], [t1], new Set(['t1']));
  it('teams first (with their members), then plain sessions, each in list order', () => {
    expect(teamsFirst(entries).map((e) => e.kind === 'team' ? `team:${e.team.id}` : e.kind === 'row' ? e.row.key : e.kind)).toEqual(['team:t1', 'lead', 'fe', 's1', 's2']);
  });
  it('under a project: team and sessions at 1, members at 2; in 不在项目中 one level up', () => {
    const depths = (base: number) => teamsFirst(entries).map((e) => entryDepth(e, base));
    expect(depths(1)).toEqual([1, 2, 2, 1, 1]);
    expect(depths(0)).toEqual([0, 1, 1, 0, 0]);
    expect(entryDepth({ kind: 'inactive', team: t1, count: 2, open: false }, 1)).toBe(2);
    expect(entryDepth({ kind: 'empty', team: t1 }, 0)).toBe(1);
  });
  it('role: the root bot is the lead', () => {
    expect(teamRowRole(t1.bots[0])).toBe('lead');
    expect(teamRowRole(t1.bots[1])).toBe('member');
    expect(teamRowRole(undefined)).toBeUndefined();
  });
});

describe('list lenses (§5.2, D3)', () => {
  it('a member shows only while it waits for you; the lead and plain sessions always', () => {
    expect(listShowsRow('member', false)).toBe(false);
    expect(listShowsRow('member', true)).toBe(true);
    expect(listShowsRow('lead', false)).toBe(true);
    expect(listShowsRow(undefined, false)).toBe(true);
  });
  it('one chip: the team for a lead / member, else the project, else none', () => {
    expect(listOwnerChip({ teamName: 'T', projectName: 'P' })).toEqual({ kind: 'team', name: 'T' });
    expect(listOwnerChip({ projectName: 'P' })).toEqual({ kind: 'project', name: 'P' });
    expect(listOwnerChip({})).toBeNull();
  });
  it('resolver: team membership wins over the project; explicit project membership for plain sessions', () => {
    const t1 = team('t1', ['lead', 'fe']);
    const of = ownerChipResolver([project('p', { teamIds: ['t1'] }), project('q')], [member('q', 'a')], [t1]);
    expect(of('fe')).toEqual({ chip: { kind: 'team', name: 't1' }, role: 'member', botName: 'M1' });
    expect(of('lead').role).toBe('lead');
    expect(of('a')).toEqual({ chip: { kind: 'project', name: 'q' }, role: undefined, botName: undefined });
    expect(of('zzz').chip).toBeNull();
    expect(of(undefined).chip).toBeNull();
  });
});

describe('keyboard (§5.1)', () => {
  // project (open) › team (folded) · session; then another project (folded)
  const items = [{ depth: 0, expanded: true }, { depth: 1, expanded: false }, { depth: 1 }, { depth: 0, expanded: false }];
  it('↑/↓ move and stop at the ends', () => {
    expect(treeKeyAction(items, 0, 'ArrowDown')).toEqual({ focus: 1 });
    expect(treeKeyAction(items, 3, 'ArrowDown')).toBeNull();
    expect(treeKeyAction(items, 0, 'ArrowUp')).toBeNull();
    expect(treeKeyAction(items, 2, 'ArrowUp')).toEqual({ focus: 1 });
  });
  it('→ opens a folded node, steps into an open one, does nothing on a leaf', () => {
    expect(treeKeyAction(items, 1, 'ArrowRight')).toEqual({ toggle: 1 });
    expect(treeKeyAction(items, 0, 'ArrowRight')).toEqual({ focus: 1 });
    expect(treeKeyAction(items, 2, 'ArrowRight')).toBeNull();
  });
  it('← folds an open node, else steps out to the parent', () => {
    expect(treeKeyAction(items, 0, 'ArrowLeft')).toEqual({ toggle: 0 });
    expect(treeKeyAction(items, 2, 'ArrowLeft')).toEqual({ focus: 0 });
    expect(treeKeyAction(items, 3, 'ArrowLeft')).toBeNull();
    expect(treeKeyAction(items, 0, 'Enter')).toBeNull();
  });
});
