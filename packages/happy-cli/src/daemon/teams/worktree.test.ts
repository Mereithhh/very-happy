import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { prepareTeamWorktree, removeTeamWorktree } from './worktree';

describe('team owned worktrees', () => {
    it('isolates attempts and retains dirty and unmerged work', async () => {
        const root = join(homedir(), 'code/github/skills/tmp/agent-teams-implementation/tests');
        mkdirSync(root, { recursive: true });
        const home = mkdtempSync(join(root, 'worktree-'));
        const repo = join(home, 'repo'); mkdirSync(repo);
        const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Teams test', '-c', 'user.email=teams@example.invalid', ...args], { stdio: 'pipe' });
        try {
            git(repo, ['init']); git(repo, ['commit', '--allow-empty', '-m', 'initial']);
            const work = await prepareTeamWorktree(home, repo, 'op1');
            expect((await prepareTeamWorktree(home, repo, 'op1')).directory).toBe(work.directory);
            writeFileSync(join(work.directory, 'result.txt'), 'result');
            await expect(removeTeamWorktree(work)).rejects.toThrow('Uncommitted');
            git(work.directory, ['add', 'result.txt']); git(work.directory, ['commit', '-m', 'result']);
            await expect(removeTeamWorktree(work)).rejects.toThrow('Unmerged');
            git(repo, ['merge', '--ff-only', work.branch]);
            await removeTeamWorktree(work);
            expect(existsSync(work.directory)).toBe(false);
        } finally { rmSync(home, { recursive: true, force: true }); }
    });
});
