import { describe, expect, it } from 'vitest';
import type { TeamState } from '@slopus/happy-wire';
import { redirectFromTeamWorktree, teamWorktreeRepository, withoutTeamWorktrees } from './teamWorktree';
import { mergeDirectoryChoices } from './terminalCwd';

const wt = (id: string, sub = '') => `/home/u/.happy/teams/worktrees/${id}${sub}`;
const team = (machineId: string, ops: [string, string][]) => ({ id: `t-${machineId}`, machineId, operations: ops.map(([id, directory]) => ({ id, type: 'spawn', directory })) }) as unknown as TeamState;
const teams = [team('m', [['wt-0001', '/code/app'], ['wt-0002', wt('wt-0001')]])];

describe('B-755 team worktree candidates', () => {
  it('resolves a worktree (and one cut from it, and a subfolder) to its repository on the same machine only', () => {
    expect(teamWorktreeRepository(teams, 'm', wt('wt-0001'))).toBe('/code/app');
    expect(teamWorktreeRepository(teams, 'm', wt('wt-0002', '/docs'))).toBe('/code/app/docs');
    expect(teamWorktreeRepository(teams, 'other', wt('wt-0001'))).toBeNull();
    expect(teamWorktreeRepository(teams, 'm', wt('gone'))).toBeNull();
    expect(teamWorktreeRepository(teams, 'm', '/code/app')).toBe('/code/app');
  });
  it('a new chat from a worktree context starts in the repository, or asks for the folder', () => {
    expect(redirectFromTeamWorktree({ machineId: 'm', path: wt('wt-0001') }, teams)).toEqual({ machineId: 'm', path: '/code/app' });
    expect(redirectFromTeamWorktree({ machineId: 'm', path: wt('gone') }, teams)).toEqual({ machineId: 'm', path: '' });
    expect(redirectFromTeamWorktree({ machineId: 'm', path: '/code/x' }, teams)).toEqual({ machineId: 'm', path: '/code/x' });
    expect(redirectFromTeamWorktree(undefined, teams)).toBeUndefined();
  });
  it('remembered-directory lists (automations, terminal chips) leave worktrees out', () => {
    expect(withoutTeamWorktrees([{ path: wt('a') }, { path: '/code' }, { path: wt('b', '/x') }])).toEqual([{ path: '/code' }]);
    expect(mergeDirectoryChoices([], [{ machineId: 'm', path: wt('a') }, { machineId: 'm', path: '/code' }], 'm').map(c => c.path)).toEqual(['/code']);
  });
});
