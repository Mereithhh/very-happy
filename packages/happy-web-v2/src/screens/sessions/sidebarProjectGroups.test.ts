import { describe, expect, it } from 'vitest';
import type { ProjectView, TeamState } from '@slopus/happy-wire';
import { groupRowsByTag } from './sidebarTagGroups';
import { groupTeamNavigation, teamSessionMembership } from './teamNavigation';
import { foldersOfRows, groupRowsByProject, legacyGroupModeFor, sessionProjectResolver, usedTagGrouping } from './sidebarProjectGroups';

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
  it('B-762: a team member follows its team’s project even when explicitly put in another (项目 ⊃ 团队 ⊃ 成员)', () => {
    const g = groupRowsByProject([row('s1'), row('s2'), row('s3')], [project('p', { teamIds: ['t'] }), project('q')], [member('q', 's2'), member('q', 's3')], [team('t', ['s1', 's2'])]);
    expect(g.projects.find(p => p.project.id === 'p')!.rows.map(r => r.key)).toEqual(['s1', 's2']);
    expect(g.projects.find(p => p.project.id === 'q')!.rows.map(r => r.key)).toEqual(['s3']);
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

describe('B-723 (O1): an unattached team groups under its own repository', () => {
  const W = '/home/u/.happy/teams/worktrees';
  it('follows the team home, not the most recently active member worktree', () => {
    const t = team('t', ['lead', 'w1', 'w2'], { creationLaunch: { goal: 'g', assistant: 'claude', directory: '/home/u/repo' } as TeamState['creationLaunch'] });
    // Ordered by recency: a worker's UUID worktree comes first.
    const rows = [row('w2', 'm', `${W}/840fb9cc`), row('lead', 'm', `${W}/fc838c27`), row('w1', 'm', `${W}/5435662d`), row('solo', 'm', '/home/u/repo')];
    const { unassigned } = groupRowsByProject(rows, [], [], [t]);
    expect(unassigned.map(g => [g.name, g.rows.map(r => r.key)])).toEqual([['repo', ['w2', 'lead', 'w1', 'solo']]]);
    expect(unassigned[0].teams.map(x => x.id)).toEqual(['t']);
  });
  it('without a launch record, uses the lead spawn directory, never a worktree', () => {
    const t = team('t', ['lead', 'w1'], { operations: [{ id: 'op', type: 'spawn', botId: 't-b0', directory: '/home/u/repo2', createdAt: 1 }] as TeamState['operations'] });
    const { unassigned } = groupRowsByProject([row('w1', 'm', `${W}/aaaa`), row('lead', 'm', `${W}/bbbb`)], [], [], [t]);
    expect(unassigned.map(g => g.path)).toEqual(['/home/u/repo2']);
  });
  it('a team with no known home keeps the old first-located-row anchor', () => {
    const t = team('t', ['lead', 'w1']);
    const { unassigned } = groupRowsByProject([row('w1', 'm', '/a'), row('lead', 'm', '/b')], [], [], [t]);
    expect(unassigned.map(g => g.path)).toEqual(['/a']);
  });
});

/**
 * B-729: the production shape on 10-22 — a Lead spawned by atlas-pay-ops that
 * created and joined atlas-pay, a reused worker's two generations, plus the Owner's own
 * chats started in a team worktree folder (no team field: never pulled in).
 * Composed the way Sidebar.tsx composes each lens, every team conversation is a
 * team child in all three, and no unrelated row is.
 */
describe('B-729 team conversations nest identically in every lens', () => {
  type R = { key: string; sessionId?: string; machineId?: string; workspacePath?: string; tags?: string[]; teamHistoryLink?: true };
  const spawn = (teamId: string, botId: string, generation: number, sessionId: string) => ({ id: `${botId}-${generation}`, teamId, machineId: 'm', taskId: 't', botId, attemptId: 'a', generation, type: 'spawn' as const, status: 'completed' as const, claimId: 'c', claimedAt: 1, error: null, sessionId, directory: '/repo', assistant: 'claude' as const, prompt: '', createdAt: generation });
  const cot = team('cot', ['L', 'w2'], { createdAt: 2 });
  cot.bots[1].generation = 2;
  cot.operations = [spawn('cot', 'cot-b0', 1, 'L'), spawn('cot', 'cot-b1', 1, 'w1'), spawn('cot', 'cot-b1', 2, 'w2')];
  const pool = team('pool', ['L', 'p'], { createdAt: 3 }); // the spawned Lead later created and joined it
  pool.bots[0].managed = false;
  const teams = [pool, cot];
  const rows: R[] = [row('L', 'm', '/wt/L'), row('mine', 'm', '/wt/L'), row('w1', 'm', '/wt/w1'), row('w2', 'm', '/wt/w2'), row('p', 'm', '/repo'), row('other', 'm', '/repo', ['x'])];
  const placement = (sections: ReturnType<typeof groupTeamNavigation<R>>[]) => Object.fromEntries(sections.flat().flatMap(e => e.kind === 'row' ? [[e.row.key, e.team?.id ?? null]] : []));
  const expected = { L: 'pool', w1: 'cot', w2: 'cot', p: 'pool', mine: null, other: null };
  const nest = (r: R[], t: TeamState[]) => groupTeamNavigation(r, t, new Set(['cot', 'pool', 't']));
  it('project lens', () => {
    const g = groupRowsByProject(rows, [], [], teams);
    expect(placement([...g.unassigned.map(u => nest(u.rows, u.teams)), ...(g.teamsGroup ? [nest(g.teamsGroup.rows, g.teamsGroup.teams)] : [])])).toEqual(expected);
  });
  it('tag lens', () => {
    const m = teamSessionMembership(teams);
    const isTeamRow = (r: R) => !!r.sessionId && m.has(r.sessionId);
    expect(placement([...groupRowsByTag(rows.filter(r => !isTeamRow(r))).map(x => x.rows.map(row => ({ kind: 'row' as const, row }))), nest(rows.filter(isTeamRow), teams)])).toEqual(expected);
  });
  it('no grouping', () => {
    expect(placement([nest(rows, teams)])).toEqual(expected);
  });
  it('B-762: a member explicitly put in another project still sits with its team, and so does the team’s history link (one place, never split)', () => {
    const t = team('t', ['s1', 's2']);
    const g = groupRowsByProject([row('s1'), history('s2')], [project('q')], [member('q', 's1')], [t]);
    expect(g.projects.find(p => p.project.id === 'q')!.rows).toEqual([]);
    expect(g.teamsGroup).toBeNull();
    expect(placement(g.unassigned.map(u => nest(u.rows, u.teams)))).toEqual({ s1: 't', s2: 't' });
  });
});

describe('projects outside the project lens (B-756)', () => {
  it('session → project for the chip: explicit membership, else its team’s project; archived projects never', () => {
    const t1 = team('t1', ['s1']);
    const of = sessionProjectResolver([project('p', { teamIds: ['t1'] }), project('q'), project('old', { archivedAt: 3 })], [member('q', 'x'), member('old', 'y')], [t1]);
    expect([of('x')?.id, of('s1')?.id, of('y'), of('none'), of(undefined)]).toEqual(['q', 'p', null, null, null]);
  });
});
