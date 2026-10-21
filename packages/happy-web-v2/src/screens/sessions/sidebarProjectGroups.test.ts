import { describe, expect, it } from 'vitest';
import type { ProjectView, TeamState } from '@slopus/happy-wire';
import { groupRowsByTag } from './sidebarTagGroups';
import { groupTeamNavigation } from './teamNavigation';
import { foldersOfRows, groupRowsByProject, legacyGroupModeFor, usedTagGrouping } from './sidebarProjectGroups';

const project = (id: string, extra: Partial<ProjectView> = {}): ProjectView => ({ id, name: id, goal: null, instructions: '', instructionsVersion: 0, instructionsUpdatedBy: null, instructionsUpdatedAt: null, folders: [], defaults: {}, archivedAt: null, createdAt: 1, updatedAt: 1, teamIds: [], automationIds: [], ...extra });
const row = (key: string, machineId = 'm', path = '/repo', tags?: string[]) => ({ key, sessionId: key, machineId, workspacePath: path, machineName: 'mac', tags });
const team = (id: string, sessions: string[], extra: Partial<TeamState> = {}): TeamState => ({ id, name: id, machineId: 'm', version: 1, bots: sessions.map((s, i) => ({ id: `${id}-b${i}`, name: `b${i}`, sessionId: s, generation: 1, root: i === 0, managed: true, assistant: 'claude', directory: null })), tasks: [], messages: [], operations: [], createdAt: 1, ...extra } as TeamState);
/** The sidebar's history link for an archived member: no machine, no folder. */
const history = (key: string) => ({ key, sessionId: key, teamHistoryLink: true as const });
const member = (projectId: string, sessionId: string) => ({ projectId, sessionId, via: 'explicit', machineId: null, createdAt: 1 });

describe('groupRowsByProject', () => {
  it('explicit members go to their project in first-appearance order; the rest fall to 未归属 by folder', () => {
    const rows = [row('a'), row('b', 'm', '/other'), row('c'), row('d')];
    const g = groupRowsByProject(rows, [project('p1'), project('p2')], [member('p2', 'c'), member('p1', 'd')], []);
    expect(g.projects.map(p => [p.project.id, p.rows.map(r => r.key)])).toEqual([['p2', ['c']], ['p1', ['d']]]);
    expect(g.unassigned.map(u => [u.path, u.rows.map(r => r.key)])).toEqual([['/repo', ['a']], ['/other', ['b']]]);
  });
  it('no projects at all → the same shape as the old workspace grouping (never empty)', () => {
    const rows = [row('a'), row('b', 'm', '/x')];
    const g = groupRowsByProject(rows, [], [], []);
    expect(g.projects).toEqual([]);
    expect(g.unassigned.flatMap(u => u.rows.map(r => r.key))).toEqual(['a', 'b']);
  });
  it('a project with no visible rows still appears (after the active ones); archived projects never do', () => {
    const g = groupRowsByProject([row('a')], [project('empty', { createdAt: 5 }), project('gone', { archivedAt: 9 }), project('busy')], [member('busy', 'a'), member('gone', 'x')], []);
    expect(g.projects.map(p => p.project.id)).toEqual(['busy', 'empty']);
  });
  it('team sessions follow the attached project, and attached teams appear even with no rows', () => {
    const t1 = team('t1', ['s1', 's2']);
    const t2 = team('t2', []);
    const rows = [row('s1', 'm', '/wt1'), row('x'), row('s2', 'm', '/wt2')];
    const g = groupRowsByProject(rows, [project('p', { teamIds: ['t1', 't2'] })], [], [t1, t2]);
    expect(g.projects[0].rows.map(r => r.key)).toEqual(['s1', 's2']);
    expect(g.projects[0].teams.map(t => t.id)).toEqual(['t1', 't2']);
    expect(g.unassigned.flatMap(u => u.rows.map(r => r.key))).toEqual(['x']);
  });
  it('explicit membership beats the team attachment', () => {
    const g = groupRowsByProject([row('s1'), row('s2')], [project('p', { teamIds: ['t'] }), project('q')], [member('q', 's2')], [team('t', ['s1', 's2'])]);
    expect(g.projects.find(p => p.project.id === 'p')!.rows.map(r => r.key)).toEqual(['s1']);
    expect(g.projects.find(p => p.project.id === 'q')!.rows.map(r => r.key)).toEqual(['s2']);
  });
  it('an unattached team stays together in its first row\'s folder group (team worktrees differ)', () => {
    const t = team('t', ['s1', 's2']);
    const g = groupRowsByProject([row('s1', 'm', '/wt/a'), row('z', 'm', '/repo'), row('s2', 'm', '/wt/b')], [], [], [t]);
    expect(g.unassigned.map(u => [u.path, u.rows.map(r => r.key), u.teams.map(x => x.id)])).toEqual([['/wt/a', ['s1', 's2'], ['t']], ['/repo', ['z'], []]]);
  });
  it('unattached teams with no visible session are reported as orphans; archived teams never', () => {
    const g = groupRowsByProject([row('a')], [], [], [team('empty', []), team('old', [], { archivedAt: 3 })]);
    expect(g.teamsGroup).toEqual({ rows: [], teams: [expect.objectContaining({ id: 'empty' })] });
    expect(groupRowsByProject([row('a')], [], [], []).teamsGroup).toBeNull();
  });
  it('B-708: a team whose members are all archived (history links, no folder) is ONE trailing group, not one 无工作目录 group per member', () => {
    const t = team('t', ['s1', 's2', 's3']);
    const g = groupRowsByProject([row('a'), history('s1'), history('s2'), history('s3')], [project('p')], [], [t]);
    expect(g.unassigned.map(u => u.rows.map(r => r.key))).toEqual([['a']]);
    expect(g.unassigned.flatMap(u => u.teams)).toEqual([]);
    expect(g.teamsGroup!.rows.map(r => r.key)).toEqual(['s1', 's2', 's3']);
    expect(g.teamsGroup!.teams.map(x => x.id)).toEqual(['t']);
  });
  it('B-708: a team with one live member anchors on that member\'s folder; its history links follow it there', () => {
    const t = team('t', ['s1', 's2']);
    const g = groupRowsByProject([history('s1'), row('s2', 'm', '/wt'), row('z', 'm', '/repo')], [], [], [t]);
    expect(g.unassigned.map(u => [u.path, u.rows.map(r => r.key), u.teams.map(x => x.id)])).toEqual([['/wt', ['s1', 's2'], ['t']], ['/repo', ['z'], []]]);
    expect(g.teamsGroup).toBeNull();
  });
  it('members of unknown or archived projects are treated as unassigned (old snapshot, deleted project)', () => {
    const g = groupRowsByProject([row('a')], [project('p', { archivedAt: 2 })], [member('p', 'a'), member('ghost', 'a')], []);
    expect(g.projects).toEqual([]);
    expect(g.unassigned[0].rows.map(r => r.key)).toEqual(['a']);
  });
});

describe('settings migration and helpers', () => {
  it('tag-grouping devices are detected from either the mode or the legacy flag', () => {
    expect(usedTagGrouping('tag', false)).toBe(true);
    expect(usedTagGrouping('none', true)).toBe(true);
    expect(usedTagGrouping('workspace', false)).toBe(false);
    expect(usedTagGrouping(undefined, undefined)).toBe(false);
  });
  it('a rollback to the old Web sees workspace for project, tag for tag (B-675) and none for none', () => {
    expect(legacyGroupModeFor('project')).toEqual({ sidebarGroupMode: 'workspace', sidebarGroupByTag: false });
    expect(legacyGroupModeFor('tag')).toEqual({ sidebarGroupMode: 'tag', sidebarGroupByTag: true });
    expect(legacyGroupModeFor('none')).toEqual({ sidebarGroupMode: 'none', sidebarGroupByTag: false });
  });
  it('folders of a converted group are unique machine+path pairs', () => {
    expect(foldersOfRows([row('a'), row('b'), row('c', 'n', '/y'), { key: 'd' }])).toEqual([{ machineId: 'm', path: '/repo' }, { machineId: 'n', path: '/y' }]);
  });
});

/**
 * B-708: the three list lenses compose these helpers exactly as Sidebar.tsx
 * does (project: per group + trailing teams group; tag: one 团队 group; none:
 * the whole list). Whatever the members' state, every team header renders
 * once and no group renders without a row of its own.
 */
describe('B-708 a team renders once in every grouping lens', () => {
  type R = { key: string; sessionId?: string; machineId?: string; workspacePath?: string; tags?: string[]; teamHistoryLink?: true };
  const nest = (rows: R[], teams: TeamState[]) => groupTeamNavigation(rows, teams, new Set());
  const lenses = (rows: R[], projects: ProjectView[], teams: TeamState[]) => {
    const g = groupRowsByProject(rows, projects, [], teams);
    const unassigned = [...g.unassigned.map(u => nest(u.rows, u.teams)), ...(g.teamsGroup ? [nest(g.teamsGroup.rows, g.teamsGroup.teams)] : [])];
    const projectLens = [...g.projects.map(p => nest(p.rows, p.teams)), ...unassigned];
    const inTeam = (r: R) => teams.some(t => t.bots.some(b => b.sessionId === r.sessionId));
    const live = rows.filter(r => !r.teamHistoryLink);
    const tagLens = [...groupRowsByTag(live.filter(r => !inTeam(r))).map(x => nest(x.rows, [])), nest(rows.filter(inTeam), teams)];
    const noneLens = [nest(rows, teams)];
    return { project: projectLens, unassigned, tag: tagLens, none: noneLens };
  };
  const headers = (sections: ReturnType<typeof nest>[]) => sections.flat().filter(e => e.kind === 'team').map(e => e.kind === 'team' ? e.team.id : '');
  for (const [label, rows] of [
    ['all members archived', [row('a'), history('s1'), history('s2'), history('s3')]],
    ['one member live, two archived', [history('s1'), row('s2', 'm', '/wt'), history('s3'), row('a')]],
    ['all members live in different worktrees', [row('s1', 'm', '/wt1'), row('a'), row('s2', 'm', '/wt2'), row('s3', 'm', '/wt3')]],
    ['no other sessions at all', [history('s1'), history('s2'), history('s3')]],
  ] as Array<[string, R[]]>) {
    it(label, () => {
      const t = team('t', ['s1', 's2', 's3']);
      const l = lenses(rows, [project('p')], [t]);
      expect(headers(l.project)).toEqual(['t']);
      expect(headers(l.tag)).toEqual(['t']);
      expect(headers(l.none)).toEqual(['t']);
      // No 未归属 sub-group holds nothing of its own: each has a real row or the team.
      for (const section of l.unassigned) expect(section.length).toBeGreaterThan(0);
      // …and the team's members never spread it over several 未归属 groups.
      expect(l.unassigned.filter(section => section.some(e => e.kind === 'team')).length).toBe(1);
    });
  }
});
