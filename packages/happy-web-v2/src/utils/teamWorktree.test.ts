import { describe, expect, it } from 'vitest';
import type { TeamState } from '@slopus/happy-wire';
import { redirectFromTeamWorktree, teamWorktreeRepository, withoutTeamWorktrees } from './teamWorktree';
import { mergeDirectoryChoices } from './terminalCwd';

const wt = (id: string, sub = '') => `/home/u/.happy/teams/worktrees/${id}${sub}`;
const team = (machineId: string, ops: [string, string][]) => ({ id: `t-${machineId}`, machineId, operations: ops.map(([id, directory]) => ({ id, type: 'spawn', directory })) }) as unknown as TeamState;
const teams = [team('m', [['f0747a90', '/code/skills'], ['801fecdb', wt('f0747a90')]])];

describe('B-755 team worktree candidates', () => {
  it('resolves a worktree (and one cut from it, and a subfolder) to its repository on the same machine only', () => {
    expect(teamWorktreeRepository(teams, 'm', wt('f0747a90'))).toBe('/code/skills');
    expect(teamWorktreeRepository(teams, 'm', wt('801fecdb', '/docs'))).toBe('/code/skills/docs');
    expect(teamWorktreeRepository(teams, 'other', wt('f0747a90'))).toBeNull();
    expect(teamWorktreeRepository(teams, 'm', wt('gone'))).toBeNull();
    expect(teamWorktreeRepository(teams, 'm', '/code/skills')).toBe('/code/skills');
  });
  it('a new chat from a worktree context starts in the repository, or asks for the folder', () => {
    expect(redirectFromTeamWorktree({ machineId: 'm', path: wt('f0747a90') }, teams)).toEqual({ machineId: 'm', path: '/code/skills' });
    expect(redirectFromTeamWorktree({ machineId: 'm', path: wt('gone') }, teams)).toEqual({ machineId: 'm', path: '' });
    expect(redirectFromTeamWorktree({ machineId: 'm', path: '/code/x' }, teams)).toEqual({ machineId: 'm', path: '/code/x' });
    expect(redirectFromTeamWorktree(undefined, teams)).toBeUndefined();
  });
  it('remembered-directory lists (automations, terminal chips) leave worktrees out', () => {
    expect(withoutTeamWorktrees([{ path: wt('a') }, { path: '/code' }, { path: wt('b', '/x') }])).toEqual([{ path: '/code' }]);
    expect(mergeDirectoryChoices([], [{ machineId: 'm', path: wt('a') }, { machineId: 'm', path: '/code' }], 'm').map(c => c.path)).toEqual(['/code']);
  });
});
