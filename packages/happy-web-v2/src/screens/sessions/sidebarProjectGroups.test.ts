import { describe, expect, it } from 'vitest';
import type { ProjectView, TeamState } from '@slopus/happy-wire';
import { foldersOfRows, groupRowsByProject, legacyGroupModeFor, tagCandidates, usedTagGrouping } from './sidebarProjectGroups';

const project = (id: string, extra: Partial<ProjectView> = {}): ProjectView => ({ id, name: id, goal: null, instructions: '', instructionsVersion: 0, instructionsUpdatedBy: null, instructionsUpdatedAt: null, folders: [], defaults: {}, archivedAt: null, createdAt: 1, updatedAt: 1, teamIds: [], automationIds: [], ...extra });
const row = (key: string, machineId = 'm', path = '/repo', tags?: string[]) => ({ key, sessionId: key, machineId, workspacePath: path, machineName: 'mac', tags });
const team = (id: string, sessions: string[], extra: Partial<TeamState> = {}): TeamState => ({ id, name: id, machineId: 'm', version: 1, bots: sessions.map((s, i) => ({ id: `${id}-b${i}`, name: `b${i}`, sessionId: s, generation: 1, root: i === 0, managed: true, assistant: 'claude', directory: null })), tasks: [], messages: [], operations: [], createdAt: 1, ...extra } as TeamState);
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
    expect(g.orphanTeams.map(t => t.id)).toEqual(['empty']);
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
  it('a rollback to the old Web sees workspace for project and none for none', () => {
    expect(legacyGroupModeFor('project')).toBe('workspace');
    expect(legacyGroupModeFor('none')).toBe('none');
  });
  it('tag candidates count first tags case-insensitively, most used first', () => {
    expect(tagCandidates([{ tags: ['Infra'] }, { tags: ['infra', 'x'] }, { tags: ['ui'] }, {}])).toEqual([{ tag: 'Infra', count: 2 }, { tag: 'ui', count: 1 }]);
  });
  it('folders of a converted group are unique machine+path pairs', () => {
    expect(foldersOfRows([row('a'), row('b'), row('c', 'n', '/y'), { key: 'd' }])).toEqual([{ machineId: 'm', path: '/repo' }, { machineId: 'n', path: '/y' }]);
  });
});
