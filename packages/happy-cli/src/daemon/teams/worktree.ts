import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute, resolve, dirname, basename } from 'node:path';
import { ensurePrivateDirectorySync } from '@/utils/secureFiles';
import { initializeOwnedWorktree } from '@/worktree/service';
const exec = promisify(execFile);
const git = async (directory: string, args: string[]) => (await exec('git', ['-C', directory, ...args], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
const gitRaw = async (directory: string, args: string[]) => (await exec('git', ['-C', directory, ...args], { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 })).stdout;

function expandHome(path: string): string {
    if (path === '~') return homedir();
    if (path.startsWith('~/') || (process.platform === 'win32' && path.startsWith('~\\'))) return join(homedir(), path.slice(2));
    return path;
}

/**
 * B-706: the checkout a team launch creates its worktree from. Launches queued by
 * older servers name the bot's previous worktree, which its cleanup (or a merged
 * branch) removed: a team worktree that is gone or no longer a Git checkout is
 * followed back to the repository its own launch receipt recorded. Anything else
 * unusable is a clear preflight failure instead of a raw git error.
 */
export async function resolveTeamRepository(home: string, repository: string, sourceOf: (operationId: string) => string | undefined): Promise<string> {
    const worktrees = resolve(home, 'teams', 'worktrees');
    let candidate = expandHome(repository);
    for (let hop = 0; hop < 8; hop++) {
        if (!isAbsolute(candidate)) break;
        const teamWorktree = resolve(dirname(candidate)) === worktrees;
        const top = await git(candidate, ['rev-parse', '--show-toplevel']).catch(() => null);
        // A leftover team worktree folder git no longer tracks is not a checkout, even
        // when an enclosing directory happens to be one.
        if (top !== null && (!teamWorktree || resolve(top) === resolve(candidate))) return candidate;
        const source = teamWorktree ? sourceOf(basename(candidate)) : undefined;
        if (!source) break;
        candidate = expandHome(source);
    }
    throw new Error(`Team repository is unavailable: ${repository} is missing or not a Git checkout. Restore the folder or delegate with an existing repository, then choose Retry launch.`);
}

/**
 * Worktrees isolate repository edits; no branch force/reset. Uncommitted input
 * is copied ONLY when the repository opts in via `.veryhappy/worktree.json`
 * (B-585: no `.env*` default here), and its setup script runs only if the owner
 * already approved that exact script on this machine.
 */
export async function prepareTeamWorktree(home: string, repository: string, id: string, origin: 'teams' | 'automation' = 'teams'): Promise<{ directory: string; repository: string; branch: string }> {
    // Resolve on the execution machine, never relative to the daemon's private home.
    repository = expandHome(repository);
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
        // Fresh worktree only (a reused one was initialized when it was created). Never throws.
        await initializeOwnedWorktree({ source: repository, worktree: directory, branch, origin });
    }
    return { directory, repository, branch };
}

/**
 * B-691: where a worktree's commits are safe without the worktree. Local
 * branches do not count — only the source checkout's HEAD and the remotes
 * (pushed, or squash-merged into the remote default branch).
 */
async function unpreservedCommits(directory: string, repository: string, rev: string): Promise<number> {
    const sourceHead = await git(repository, ['rev-parse', 'HEAD']).catch(() => '');
    const pending = (await git(directory, ['rev-list', rev, '--not', '--remotes', ...(sourceHead ? [sourceHead] : [])])).split('\n').filter(Boolean);
    if (pending.length === 0) return 0;
    return await squashMerged(directory, rev) ? 0 : pending.length;
}

/** `land-pr` squash-merges and deletes the remote branch: the combined change of
 *  the branch then appears as one commit on the remote default branch. */
async function squashMerged(directory: string, rev: string): Promise<boolean> {
    const target = await git(directory, ['rev-parse', '--abbrev-ref', 'refs/remotes/origin/HEAD']).catch(() => '')
        || (await git(directory, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']).then(() => 'origin/main', () => ''));
    if (!target) return false;
    const base = await git(directory, ['merge-base', rev, target]).catch(() => '');
    if (!base) return false;
    const own = patchIds(await gitRaw(directory, ['diff', base, rev]).then(diff => diff ? patchIdOf(directory, diff) : '', () => ''));
    if (own.length !== 1) return false;
    const merged = patchIds(await gitRaw(directory, ['log', '-p', '--no-merges', '--max-count=500', `${base}..${target}`]).then(log => log ? patchIdOf(directory, log) : '', () => ''));
    return merged.includes(own[0]);
}

async function patchIdOf(directory: string, patch: string): Promise<string> {
    return await new Promise((resolvePatch, reject) => {
        const child = execFile('git', ['-C', directory, 'patch-id', '--stable'], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolvePatch(stdout));
        child.stdin?.end(patch);
    });
}
const patchIds = (output: string) => output.split('\n').filter(Boolean).map(line => line.split(' ')[0]);

async function registeredWorktree(repository: string, directory: string): Promise<boolean> {
    const list = await git(repository, ['worktree', 'list', '--porcelain']).catch(() => '');
    return list.split('\n').some(line => line.startsWith('worktree ') && resolve(line.slice('worktree '.length)) === resolve(directory));
}

const describeHead = async (directory: string) => await git(directory, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '') || 'a detached HEAD';

/**
 * Preserve dirty or unpushed work. Throwing is a visible cleanup failure with
 * the owner's next step, never success. B-691: a worker that switched to its own
 * `team/B-xxx` branch and pushed / merged it is cleaned up; a directory that is
 * already gone counts as cleaned.
 */
export async function removeTeamWorktree(resource: { directory?: string; repository?: string; branch?: string }): Promise<void> {
    const { directory, repository, branch } = resource;
    if (!directory || !repository || !branch) return;
    let present = existsSync(directory);
    if (present) {
        const top = await git(directory, ['rev-parse', '--show-toplevel']).catch(() => '');
        if (!top || resolve(top) !== resolve(directory)) {
            // B-691: the worktree itself was already removed (dev-sg: an empty
            // directory, or only ignored caches such as node_modules/.vite that a
            // running tool recreated). Git no longer tracks it: cleaned. Nothing
            // in it is deleted except an empty directory.
            if (await registeredWorktree(repository, directory)) throw new Error(`${directory} is registered as a worktree but its git link is broken; inspect it, then mark this cleanup as handled`);
            if (readdirSync(directory).length === 0) rmdirSync(directory);
            present = false;
        }
    }
    if (present) {
        const actualCommon = await git(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
        const expectedCommon = await git(repository, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
        if (resolve(actualCommon) !== resolve(expectedCommon)) throw new Error('Worktree repository changed; preserve for manual reconciliation');
        const dirty = (await git(directory, ['status', '--porcelain'])).split('\n').filter(Boolean).length;
        if (dirty) throw new Error(`Uncommitted work retained at ${directory} (${dirty} changed file${dirty === 1 ? '' : 's'}): commit and push it, or discard it, then retry cleanup`);
        const head = await describeHead(directory);
        const unsafe = await unpreservedCommits(directory, repository, 'HEAD');
        if (unsafe) throw new Error(`Unmerged work retained on ${head} at ${directory}: ${unsafe} commit${unsafe === 1 ? ' is' : 's are'} not pushed or merged; push or merge, then retry cleanup`);
    }
    // The team's own branch is deleted only when nothing on it would be lost.
    const ownBranch = await git(repository, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
    if (ownBranch) {
        const unsafe = await unpreservedCommits(repository, repository, `refs/heads/${branch}`);
        if (unsafe) throw new Error(`Unmerged work retained on ${branch}: ${unsafe} commit${unsafe === 1 ? ' is' : 's are'} not pushed or merged; push or merge, then retry cleanup`);
    }
    if (present) await git(repository, ['worktree', 'remove', directory]); // refuses a dirty tree
    else await git(repository, ['worktree', 'prune']).catch(() => undefined); // B-691: already gone = cleaned
    if (ownBranch) await git(repository, ['branch', '-D', branch]);
}
