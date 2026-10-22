import { describe, expect, it } from 'vitest';
import type { ProjectView, TeamState } from '@slopus/happy-wire';
import { projectTrail, sessionTrail, teamTrail, trailCopy, visibleTrail } from './locationTrail';
import { teamProjectMenu } from '@/screens/projects/projectChoice';

const project = (id: string, extra: Partial<ProjectView> = {}): ProjectView => ({ id, name: `Project ${id}`, goal: null, instructions: '', instructionsVersion: 0, instructionsUpdatedBy: null, instructionsUpdatedAt: null, folders: [], defaults: {}, archivedAt: null, createdAt: 1, updatedAt: 1, teamIds: [], automationIds: [], ...extra });
const team = (id: string, sessions: string[], extra: Partial<TeamState> = {}): TeamState => ({ id, name: `Team ${id}`, machineId: 'm', version: 1, bots: sessions.map((s, i) => ({ id: `${id}-b${i}`, name: i === 0 ? 'Lead' : `worker-${i}`, sessionId: s, generation: 1, root: i === 0, managed: true, assistant: 'claude', directory: null })), tasks: [], messages: [], operations: [], createdAt: 1, ...extra } as TeamState);
const member = (projectId: string, sessionId: string) => ({ projectId, sessionId, via: 'explicit', machineId: null, createdAt: 1 });
const copy = trailCopy(true);

describe('sessionTrail (B-763)', () => {
  it('a member of a team in a project: 项目 › 团队, and the member name for the title', () => {
    const t = sessionTrail('s2', { projects: [project('p', { teamIds: ['t'] })], members: [] }, [team('t', ['s1', 's2'])]);
    expect(t.ancestors).toEqual([
      { kind: 'project', label: 'Project p', href: '/projects/p' },
      { kind: 'team', label: 'Team t', href: '/teams/t' },
    ]);
    expect(t.member).toEqual({ name: 'worker-1', lead: false });
  });
  it('the lead is marked as the lead', () => {
    expect(sessionTrail('s1', { projects: [], members: [] }, [team('t', ['s1', 's2'])]).member).toEqual({ name: 'Lead', lead: true });
  });
  it('a plain session in a project: only the project', () => {
    const t = sessionTrail('x', { projects: [project('p')], members: [member('p', 'x')] }, []);
    expect(t.ancestors.map((s) => s.kind)).toEqual(['project']);
    expect(t.member).toBeNull();
  });
  it('a session in nothing has no trail (the header stays title-only)', () => {
    expect(sessionTrail('x', { projects: [project('p')], members: [] }, [team('t', ['s1'])]).ancestors).toEqual([]);
  });
  it('a team in no project: just the team', () => {
    expect(sessionTrail('s1', { projects: [], members: [] }, [team('t', ['s1'])]).ancestors.map((s) => s.kind)).toEqual(['team']);
  });
  it('placement matches the tree (项目 ⊃ 团队 ⊃ 成员): a member follows its team even when explicitly put elsewhere; archived projects are ignored', () => {
    const projects = [project('p', { teamIds: ['t'] }), project('q'), project('gone', { archivedAt: 5 })];
    expect(sessionTrail('s2', { projects, members: [member('q', 's2')] }, [team('t', ['s1', 's2'])]).ancestors.map((s) => s.href)).toEqual(['/projects/p', '/teams/t']);
    expect(sessionTrail('x', { projects, members: [member('gone', 'x')] }, []).ancestors).toEqual([]);
  });
  it('a session of an archived team is placed like any other session (its explicit project, no team step)', () => {
    const t = sessionTrail('s1', { projects: [project('q')], members: [member('q', 's1')] }, [team('t', ['s1'], { archivedAt: 9 })]);
    expect(t.ancestors.map((s) => s.kind)).toEqual(['project']);
    expect(t.member).toBeNull();
  });
  it('a conversation claimed by a live team and a newer archived one names the live team (the one it is placed in)', () => {
    const t = sessionTrail('s', { projects: [], members: [] }, [team('live', ['s'], { createdAt: 1 }), team('old', ['s'], { createdAt: 5, archivedAt: 9 })]);
    expect(t.ancestors).toEqual([{ kind: 'team', label: 'Team live', href: '/teams/live' }]);
  });
  it('ids are URL-encoded in hrefs', () => {
    const t = sessionTrail('s', { projects: [project('a/b', { teamIds: ['c d'] })], members: [] }, [team('c d', ['s'])]);
    expect(t.ancestors.map((s) => s.href)).toEqual(['/projects/a%2Fb', '/teams/c%20d']);
  });
});

describe('teamTrail / projectTrail', () => {
  it('a team in a project → the project; a team in none → the Teams list', () => {
    expect(teamTrail({ id: 't' }, [project('p', { teamIds: ['t'] })], copy)).toEqual([{ kind: 'project', label: 'Project p', href: '/projects/p' }]);
    expect(teamTrail({ id: 't' }, [project('p', { teamIds: ['t'], archivedAt: 3 })], copy)).toEqual([{ kind: 'teams', label: '团队', href: '/teams' }]);
  });
  it('a project page → the Projects list', () => {
    expect(projectTrail(trailCopy(false))).toEqual([{ kind: 'projects', label: 'Projects', href: '/projects' }]);
  });
});

describe('visibleTrail', () => {
  const full = sessionTrail('s2', { projects: [project('p', { teamIds: ['t'] })], members: [] }, [team('t', ['s1', 's2'])]).ancestors;
  it('desktop shows the whole path; phones only the parent (上一级 › 当前)', () => {
    expect(visibleTrail(full, false).map((s) => s.kind)).toEqual(['project', 'team']);
    expect(visibleTrail(full, true).map((s) => s.kind)).toEqual(['team']);
    expect(visibleTrail([], true)).toEqual([]);
  });
});

describe('teamProjectMenu (换项目…)', () => {
  const ready = (projects: ProjectView[]) => ({ status: 'ready', projects });
  it('换项目… in a project, 放进项目… in none', () => {
    expect(teamProjectMenu({ id: 't' }, ready([project('p', { teamIds: ['t'] })]), { zh: true })).toBe('换项目…');
    expect(teamProjectMenu({ id: 't' }, ready([project('p')]), { zh: true })).toBe('放进项目…');
    expect(teamProjectMenu({ id: 't' }, ready([]), { zh: false })).toBe('Put in a project…');
  });
  it('hidden for an archived team or while projects are not loaded', () => {
    expect(teamProjectMenu({ id: 't', archivedAt: 1 }, ready([]), { zh: true })).toBeNull();
    expect(teamProjectMenu({ id: 't' }, { status: 'loading', projects: [] }, { zh: true })).toBeNull();
  });
});
