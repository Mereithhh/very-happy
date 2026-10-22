import { describe, expect, it } from 'vitest';
import { isInsideTeamWorktree, rebaseTeamWorktreePath, resolveTeamWorktreePath, teamWorktreeId } from './teamWorktree';

describe('team worktree paths (B-755)', () => {
    it('recognises a worktree root and folders inside it, on any OS', () => {
        expect(teamWorktreeId('/home/u/.happy/teams/worktrees/wt-0001')).toBe('wt-0001');
        expect(teamWorktreeId('/home/u/.happy/teams/worktrees/wt-0001/')).toBe('wt-0001');
        expect(teamWorktreeId('/home/u/.happy/teams/worktrees/wt-0001/src/a')).toBe('wt-0001');
        expect(isInsideTeamWorktree('C:\\Users\\u\\.happy\\teams\\worktrees\\abc\\pkg')).toBe(true);
        expect(isInsideTeamWorktree('/home/u/code/teams/worktrees-notes')).toBe(false);
        expect(isInsideTeamWorktree('/home/u/.happy/teams/worktrees')).toBe(false);
        expect(isInsideTeamWorktree('/home/u/code/app')).toBe(false);
        expect(isInsideTeamWorktree(null)).toBe(false);
    });
    it('rebases onto the repository, keeping the subfolder', () => {
        expect(rebaseTeamWorktreePath('/h/.happy/teams/worktrees/x', '/repo')).toBe('/repo');
        expect(rebaseTeamWorktreePath('/h/.happy/teams/worktrees/x/pkg/a/', '/repo/')).toBe('/repo/pkg/a');
        expect(rebaseTeamWorktreePath('/repo/pkg', '/other')).toBe('/repo/pkg');
    });
    it('follows worktrees cut from worktrees and gives null for unknown ones', async () => {
        const sources: Record<string, string> = { a: '/h/.happy/teams/worktrees/b', b: '/code/app' };
        const lookup = (id: string) => sources[id] ?? null;
        expect(await resolveTeamWorktreePath('/h/.happy/teams/worktrees/a/docs', lookup)).toBe('/code/app/docs');
        expect(await resolveTeamWorktreePath('/code/app', lookup)).toBe('/code/app');
        expect(await resolveTeamWorktreePath('/h/.happy/teams/worktrees/zzz', lookup)).toBeNull();
        expect(await resolveTeamWorktreePath('/h/.happy/teams/worktrees/loop', id => `/h/.happy/teams/worktrees/${id}`)).toBeNull();
    });
});
