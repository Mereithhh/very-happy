import { describe, expect, it } from 'vitest';
import type { ProjectMemberView, ProjectView } from '@slopus/happy-wire';
import { linkableTeams, pickerLabel, projectOfTeam, sessionProject, sessionProjectMenu, teamMoveSource, teamProjectFromChoice } from './projectChoice';

const project = (id: string, teamIds: string[] = [], extra: Partial<ProjectView> = {}): ProjectView => ({
  id, name: id.toUpperCase(), goal: null, instructions: '', instructionsVersion: 0, instructionsUpdatedBy: null, instructionsUpdatedAt: null,
  folders: [], defaults: {}, archivedAt: null, createdAt: 0, updatedAt: 0, teamIds, automationIds: [], ...extra,
});
const member = (sessionId: string, projectId: string, via = 'explicit', teamId?: string): ProjectMemberView => ({ projectId, sessionId, via, machineId: null, createdAt: 0, ...(teamId ? { teamId } : {}) });

describe('B-726 project choice helpers', () => {
  it('new team request: 新建同名项目 → create, existing → projectId, 不放进项目 → no field (old request shape)', () => {
    expect(teamProjectFromChoice({ kind: 'new' })).toEqual({ create: true });
    expect(teamProjectFromChoice({ kind: 'existing', projectId: 'p' })).toEqual({ projectId: 'p' });
    expect(teamProjectFromChoice({ kind: 'none' })).toBeUndefined();
  });

  it('labels the picker, naming the would-be project', () => {
    expect(pickerLabel({ kind: 'new' }, [], { zh: true, newName: ' Alpha ', none: '无' })).toBe('新建同名项目「Alpha」');
    expect(pickerLabel({ kind: 'new' }, [], { zh: false, newName: '', none: 'None' })).toBe('New project with the same name');
    expect(pickerLabel({ kind: 'existing', projectId: 'a' }, [project('a')], { zh: true, none: '无' })).toBe('A');
    expect(pickerLabel({ kind: 'none' }, [], { zh: true, none: '不放进项目' })).toBe('不放进项目');
  });

  it("a team's project comes from the fresh snapshot (teamIds), so a detach shows at once", () => {
    expect(projectOfTeam({ id: 't1' }, [project('a'), project('b', ['t1'])])?.id).toBe('b');
    expect(projectOfTeam({ id: 't1' }, [project('a')])).toBeNull();
  });

  it('project page「关联已有团队」lists live teams not already in this project', () => {
    const teams = [{ id: 'in', archivedAt: undefined }, { id: 'elsewhere', archivedAt: undefined }, { id: 'free', archivedAt: undefined }, { id: 'old', archivedAt: 5 }];
    expect(linkableTeams(teams, 'a', [project('a', ['in']), project('b', ['elsewhere'])]).map((t) => t.id)).toEqual(['elsewhere', 'free']);
  });

  it('B-772 (QA4 O3): linking a team that lives in another project names that project, so the link confirms the move', () => {
    const projects = [project('a', ['t1']), project('b')];
    expect(teamMoveSource({ id: 't1' }, 'b', projects)?.name).toBe('A');
    expect(teamMoveSource({ id: 't1' }, 'a', projects)).toBeNull();
    expect(teamMoveSource({ id: 'free' }, 'b', projects)).toBeNull();
  });

  it('session entries: explicit members can leave; team members follow their team', () => {
    const projects = [project('a')];
    expect(sessionProject('s1', [member('s1', 'a')], projects)).toMatchObject({ canLeave: true, via: 'explicit' });
    expect(sessionProject('s2', [member('s2', 'a', 'team', 't')], projects)).toMatchObject({ canLeave: false, teamId: 't' });
    expect(sessionProject('s3', [], projects)).toMatchObject({ project: null, canLeave: false });
  });

  it('session header menu: 移到项目… / 换项目… + 从「X」移出; nothing when shared or projects unavailable', () => {
    const snap = { status: 'ready', projects: [project('a')], members: [member('s1', 'a'), member('s2', 'a', 'team', 't')] };
    expect(sessionProjectMenu('s0', snap, { shared: false, zh: true })).toEqual({ move: '移到项目…', leave: null });
    expect(sessionProjectMenu('s1', snap, { shared: false, zh: true })).toEqual({ move: '换项目…', leave: { projectId: 'a', label: '从「A」移出' } });
    expect(sessionProjectMenu('s2', snap, { shared: false, zh: true }).leave).toBeNull();
    expect(sessionProjectMenu('s1', snap, { shared: true, zh: true })).toEqual({ move: null, leave: null });
    expect(sessionProjectMenu('s1', { ...snap, status: 'unavailable' }, { shared: false, zh: true })).toEqual({ move: null, leave: null });
  });
});
