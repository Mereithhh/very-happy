/**
 * B-762 / B-763: the one placement rule shared by the sidebar tree and the
 * breadcrumbs — a team member follows its team's project.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectMemberView, ProjectView, TeamState } from '@slopus/happy-wire';
import { resolveSessionPlacement, sessionPlacementResolver } from './sessionPlacement';

const project = (id: string, extra: Partial<ProjectView> = {}) => ({ id, name: id, archivedAt: null, teamIds: [], ...extra }) as unknown as ProjectView;
const member = (projectId: string, sessionId: string) => ({ projectId, sessionId, via: 'explicit', machineId: null, createdAt: 1 }) as ProjectMemberView;
const team = (id: string, sessions: string[], extra: Partial<TeamState> = {}) => ({
  id, name: id, machineId: 'm', version: 1, createdAt: 1, tasks: [], messages: [], operations: [],
  bots: sessions.map((sessionId, i) => ({ id: `${id}-${i}`, name: `b${i}`, sessionId, root: i === 0, generation: 1, managed: true, assistant: 'claude', directory: null })),
  ...extra,
}) as TeamState;

describe('sessionPlacementResolver', () => {
  const projects = [project('X', { teamIds: ['t'] }), project('Y'), project('old', { archivedAt: 5, teamIds: ['t2'] } as Partial<ProjectView>)];
  const teams = [team('t', ['lead', 'm1']), team('t2', ['l2']), team('gone', ['g'], { archivedAt: 3 } as Partial<TeamState>)];
  const members = [member('Y', 'm1'), member('Y', 'plain'), member('old', 'stale'), member('Y', 'g')];
  const place = sessionPlacementResolver(projects, members, teams);

  it('a member follows its team’s project, even when explicitly put in another one', () => {
    expect(place('m1')).toEqual({ projectId: 'X', teamId: 't' });
    expect(place('lead')).toEqual({ projectId: 'X', teamId: 't' });
  });
  it('a team without a live project keeps its members out of every project', () => {
    expect(place('l2')).toEqual({ projectId: null, teamId: 't2' });
  });
  it('other sessions: explicit membership in a live project, else none', () => {
    expect(place('plain')).toEqual({ projectId: 'Y' });
    expect(place('stale')).toEqual({ projectId: null });
    expect(place('nobody')).toEqual({ projectId: null });
    expect(place(undefined)).toEqual({ projectId: null });
  });
  it('an archived team does not claim its sessions', () => {
    expect(place('g')).toEqual({ projectId: 'Y' });
  });
  it('the one-off form agrees', () => {
    expect(resolveSessionPlacement('m1', { projects, members, teams })).toEqual({ projectId: 'X', teamId: 't' });
  });
});
