import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { prepareTeamWorktree, removeTeamWorktree, resolveTeamRepository } from './worktree';

describe('team owned worktrees', () => {
    it('isolates attempts and retains dirty and unmerged work', async () => {
        const root = join(homedir(), 'code/github/skills/tmp/agent-teams-implementation/tests');
        mkdirSync(root, { recursive: true });
        const home = mkdtempSync(join(root, 'worktree-'));
        const repo = join(home, 'repo'); mkdirSync(repo);
        const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Teams test', '-c', 'user.email=teams@example.invalid', ...args], { stdio: 'pipe' });
        try {
            git(repo, ['init']); git(repo, ['commit', '--allow-empty', '-m', 'initial']);
            const shorthand = '~/'+relative(homedir(), repo).split('\\').join('/');
            const work = await prepareTeamWorktree(home, shorthand, 'op1');
            expect(work.repository).toBe(repo);
            await expect(prepareTeamWorktree(home, 'relative/repo', 'relative')).rejects.toThrow('absolute');
            await expect(prepareTeamWorktree(home, '~someone/repo', 'other')).rejects.toThrow('absolute');
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

    // B-691: workers switch to their own team/B-xxx branch, push it, and land it
    // (squash). Cleanup used to stop at "branch changed"; it must now clean what
    // is safe and still never delete unpushed or uncommitted work.
    const setup = () => {
        const root = join(homedir(), 'code/github/skills/tmp/agent-teams-implementation/tests');
        mkdirSync(root, { recursive: true });
        const home = mkdtempSync(join(root, 'cleanup-'));
        const origin = join(home, 'origin.git'); const repo = join(home, 'repo'); mkdirSync(repo);
        const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Teams test', '-c', 'user.email=teams@example.invalid', ...args], { stdio: 'pipe' }).toString().trim();
        git(home, ['init', '--bare', '-b', 'main', origin]);
        git(repo, ['init', '-b', 'main']); git(repo, ['commit', '--allow-empty', '-m', 'initial']);
        git(repo, ['remote', 'add', 'origin', origin]); git(repo, ['push', '-u', 'origin', 'main']);
        git(repo, ['remote', 'set-head', 'origin', 'main']);
        // The source checkout is detached like dev-sg's shared checkout: its HEAD proves nothing new.
        git(repo, ['checkout', '--detach']);
        const commit = (dir: string, file: string) => { writeFileSync(join(dir, file), file); git(dir, ['add', file]); git(dir, ['commit', '-m', file]); };
        return { home, origin, repo, git, commit };
    };
    const refExists = (git: (cwd: string, args: string[]) => string, repo: string, ref: string) => { try { git(repo, ['show-ref', '--verify', ref]); return true; } catch { return false; } };

    it('cleans a worktree whose own team/B-xxx branch was pushed, keeping that branch', async () => {
        const { home, repo, git, commit } = setup();
        try {
            const work = await prepareTeamWorktree(home, repo, 'op2');
            git(work.directory, ['checkout', '-b', 'team/B-1-fix']); commit(work.directory, 'fix.txt');
            await expect(removeTeamWorktree(work)).rejects.toThrow('Unmerged work retained on team/B-1-fix');
            expect(existsSync(work.directory)).toBe(true);
            git(work.directory, ['push', '-u', 'origin', 'team/B-1-fix']);
            await removeTeamWorktree(work);
            expect(existsSync(work.directory)).toBe(false);
            expect(refExists(git, repo, `refs/heads/${work.branch}`)).toBe(false);
            expect(refExists(git, repo, 'refs/heads/team/B-1-fix')).toBe(true);
        } finally { rmSync(home, { recursive: true, force: true }); }
    });
    it('cleans a squash-merged branch whose remote branch was deleted', async () => {
        const { home, repo, origin, git, commit } = setup();
        try {
            const work = await prepareTeamWorktree(home, repo, 'op3');
            git(work.directory, ['checkout', '-b', 'team/B-2-feat']); commit(work.directory, 'a.txt'); commit(work.directory, 'b.txt');
            git(work.directory, ['push', '-u', 'origin', 'team/B-2-feat']);
            // land-pr: squash onto main, delete the remote branch, fetch --prune.
            const lander = join(home, 'lander'); git(home, ['clone', '-q', origin, lander]);
            git(lander, ['merge', '--squash', 'origin/team/B-2-feat']); git(lander, ['commit', '-m', 'B-2 squash']);
            git(lander, ['push', 'origin', 'main', ':team/B-2-feat']);
            git(repo, ['fetch', '--prune', 'origin']);
            await removeTeamWorktree(work);
            expect(existsSync(work.directory)).toBe(false);
        } finally { rmSync(home, { recursive: true, force: true }); }
    });
    it('never deletes uncommitted files or unpushed detached commits', async () => {
        const { home, repo, git, commit } = setup();
        try {
            const work = await prepareTeamWorktree(home, repo, 'op4');
            git(work.directory, ['checkout', '-b', 'team/B-3']); commit(work.directory, 'c.txt'); git(work.directory, ['push', 'origin', 'team/B-3']);
            writeFileSync(join(work.directory, 'scratch.txt'), 'unsaved');
            await expect(removeTeamWorktree(work)).rejects.toThrow('Uncommitted work retained');
            expect(existsSync(join(work.directory, 'scratch.txt'))).toBe(true);
            rmSync(join(work.directory, 'scratch.txt'));
            git(work.directory, ['checkout', '--detach']); commit(work.directory, 'd.txt');
            await expect(removeTeamWorktree(work)).rejects.toThrow('Unmerged work retained on a detached HEAD');
            expect(existsSync(work.directory)).toBe(true);
            git(work.directory, ['checkout', 'team/B-3']); // the detached commit is now only in the reflog…
            await removeTeamWorktree(work); // …HEAD itself is pushed, so this is the owner's choice already made
            expect(existsSync(work.directory)).toBe(false);
        } finally { rmSync(home, { recursive: true, force: true }); }
    });
    it('keeps everything when the team branch itself holds unpushed commits', async () => {
        const { home, repo, git, commit } = setup();
        try {
            const work = await prepareTeamWorktree(home, repo, 'op5');
            commit(work.directory, 'e.txt'); // on codex/team-op5
            git(work.directory, ['checkout', '-b', 'team/B-4', 'origin/main']);
            await expect(removeTeamWorktree(work)).rejects.toThrow(`Unmerged work retained on ${work.branch}`);
            expect(existsSync(work.directory)).toBe(true);
            expect(refExists(git, repo, `refs/heads/${work.branch}`)).toBe(true);
        } finally { rmSync(home, { recursive: true, force: true }); }
    });
    it('treats a worktree directory that is already gone as cleaned', async () => {
        const { home, repo, git } = setup();
        try {
            const work = await prepareTeamWorktree(home, repo, 'op6');
            rmSync(work.directory, { recursive: true, force: true });
            await removeTeamWorktree(work);
            expect(refExists(git, repo, `refs/heads/${work.branch}`)).toBe(false);
            expect(git(repo, ['worktree', 'list'])).not.toContain('op6');
        } finally { rmSync(home, { recursive: true, force: true }); }
    });
    it('refuses to touch a registered worktree whose git link is broken', async () => {
        const { home, repo } = setup();
        try {
            const work = await prepareTeamWorktree(home, repo, 'op7');
            rmSync(join(work.directory, '.git'));
            writeFileSync(join(work.directory, 'keep.txt'), 'keep');
            await expect(removeTeamWorktree(work)).rejects.toThrow('git link is broken');
            expect(existsSync(join(work.directory, 'keep.txt'))).toBe(true);
        } finally { rmSync(home, { recursive: true, force: true }); }
    });
    it('treats an already removed worktree as cleaned, leaving leftover caches untouched', async () => {
        const { home, repo, git } = setup();
        try {
            // dev-sg: `git worktree remove` ran, then a dev server recreated node_modules/.vite.
            const work = await prepareTeamWorktree(home, repo, 'op8');
            git(repo, ['worktree', 'remove', work.directory]);
            mkdirSync(join(work.directory, 'node_modules', '.vite'), { recursive: true });
            writeFileSync(join(work.directory, 'node_modules', '.vite', '_metadata.json'), '{}');
            await removeTeamWorktree(work);
            expect(existsSync(join(work.directory, 'node_modules', '.vite', '_metadata.json'))).toBe(true);
            const empty = await prepareTeamWorktree(home, repo, 'op9');
            git(repo, ['worktree', 'remove', empty.directory]); mkdirSync(empty.directory);
            await removeTeamWorktree(empty);
            expect(existsSync(empty.directory)).toBe(false);
        } finally { rmSync(home, { recursive: true, force: true }); }
    });
    it('B-706: a removed team worktree resolves back to its source repository', async () => {
        const root = join(homedir(), 'code/github/skills/tmp/agent-teams-implementation/tests');
        mkdirSync(root, { recursive: true });
        const home = mkdtempSync(join(root, 'reactivate-'));
        const repo = join(home, 'repo'); mkdirSync(repo);
        const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Teams test', '-c', 'user.email=teams@example.invalid', ...args], { stdio: 'pipe' });
        try {
            git(repo, ['init']); git(repo, ['commit', '--allow-empty', '-m', 'initial']);
            const first = await prepareTeamWorktree(home, repo, 'op1');
            // A child launched from the member's worktree, then both removed (cleanup / merged branch).
            const child = await prepareTeamWorktree(home, first.directory, 'op2');
            const receipts: Record<string, string> = { op1: first.repository, op2: child.repository };
            const sourceOf = (id: string) => receipts[id];
            expect(await resolveTeamRepository(home, first.directory, sourceOf)).toBe(first.directory); // still a checkout: unchanged
            git(repo, ['worktree', 'remove', child.directory]); git(repo, ['worktree', 'remove', first.directory]);
            expect(await resolveTeamRepository(home, child.directory, sourceOf)).toBe(repo);
            // Leftovers git no longer tracks are not a checkout, even inside an enclosing repository.
            mkdirSync(first.directory); writeFileSync(join(first.directory, 'leftover.txt'), 'x');
            expect(await resolveTeamRepository(home, first.directory, sourceOf)).toBe(repo);
            const relaunch = await prepareTeamWorktree(home, await resolveTeamRepository(home, first.directory, sourceOf), 'op3');
            expect(existsSync(relaunch.directory)).toBe(true);
            await expect(resolveTeamRepository(home, join(home, 'teams', 'worktrees', 'unknown'), sourceOf)).rejects.toThrow('Team repository is unavailable');
            await expect(resolveTeamRepository(home, join(home, 'gone'), sourceOf)).rejects.toThrow('Retry launch');
        } finally { rmSync(home, { recursive: true, force: true }); }
    });
});

