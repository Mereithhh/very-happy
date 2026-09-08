import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { ensurePrivateDirectorySync } from '@/utils/secureFiles';
const exec = promisify(execFile);
const git = async (directory: string, args: string[]) => (await exec('git', ['-C', directory, ...args], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();

/** Worktrees isolate repository edits; no branch force/reset and no uncommitted input copying. */
export async function prepareTeamWorktree(home: string, repository: string, id: string): Promise<{ directory: string; repository: string; branch: string }> {
    if (!isAbsolute(repository) || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('A team task requires an absolute repository path and valid operation id');
    await git(repository, ['rev-parse', '--show-toplevel']);
    const root = join(home, 'teams', 'worktrees');
    ensurePrivateDirectorySync(root);
    const directory = join(root, id);
    const branch = `codex/team-${id}`;
    if (existsSync(directory)) {
        const actual = await git(directory, ['symbolic-ref', '--short', 'HEAD']);
        if (actual !== branch) throw new Error('Team worktree path is occupied by another branch');
        const common = await git(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
        const expected = await git(repository, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
        if (resolve(common) !== resolve(expected)) throw new Error('Team worktree belongs to another repository');
    } else {
        await git(repository, ['worktree', 'add', '-b', branch, directory, 'HEAD']);
    }
    return { directory, repository, branch };
}

/** Preserve dirty or unmerged work. Returning a reason is a visible cleanup failure, not success. */
export async function removeTeamWorktree(resource: { directory?: string; repository?: string; branch?: string }): Promise<void> {
    const { directory, repository, branch } = resource;
    if (!directory || !repository || !branch) return;
    if (existsSync(directory)) {
        if (await git(directory, ['status', '--porcelain'])) throw new Error(`Uncommitted work retained at ${directory}`);
        // Only remove a branch whose commits reached the source checkout. Squash merges require explicit owner handling.
        await git(repository, ['merge-base', '--is-ancestor', branch, 'HEAD']).catch(() => { throw new Error(`Unmerged work retained on ${branch} at ${directory}`); });
        await git(repository, ['worktree', 'remove', directory]);
    }
    try { await git(repository, ['show-ref', '--verify', `refs/heads/${branch}`]); }
    catch { return; }
    await git(repository, ['branch', '-d', branch]);
}
