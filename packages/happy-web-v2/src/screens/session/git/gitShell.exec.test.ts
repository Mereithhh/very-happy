/**
 * Runs the built command strings through a real /bin/sh + git (the same way
 * the CLI's `bash` RPC does: child_process.exec, default shell) against a
 * throw-away repo with a local bare remote. Skipped where git or /bin/sh is
 * missing (Windows CI).
 */
import { execSync, exec } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCommitCommand, buildJobPoll, buildJobStart, buildProbeCommand, buildPushCommand, commitCandidates, parseJobPoll, parseJobStart, parseProbe } from './gitShell';
import { parseStatusSummaryV2 } from '@/sync/git-parsers/parseStatusV2';

const hasGit = (() => {
    if (process.platform === 'win32') return false;
    try { execSync('git --version', { stdio: 'ignore' }); return true; } catch { return false; }
})();

function sh(command: string, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        exec(command, { cwd, timeout: 20_000 }, (error, stdout, stderr) => {
            resolve({ code: error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
        });
    });
}

describe.skipIf(!hasGit)('git commands against a real repo', () => {
    let root: string;
    let repo: string;
    const git = (args: string) => execSync(`git ${args}`, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });

    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), 'vh-git-test-'));
        execSync('git init -q --bare -b main remote.git', { cwd: root });
        repo = join(root, 'work');
        execSync(`git clone -q remote.git work 2>/dev/null`, { cwd: root });
        git('config user.email t@example.com');
        git('config user.name T');
        git('config commit.gpgsign false');
        writeFileSync(join(repo, 'keep.txt'), 'k\n');
        writeFileSync(join(repo, 'old.txt'), 'o\n');
        writeFileSync(join(repo, 'gone.txt'), 'g\n');
        git('add -A');
        git('commit -q -m init');
        git('push -q origin main');
        git('remote set-head origin -a');
    });
    afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

    it('partial commit: rename + staged deletion + untracked with quote, unselected staged file stays staged', async () => {
        git('checkout -q -b feat/x');
        git('mv old.txt new.txt');
        git('rm -q gone.txt');
        writeFileSync(join(repo, "it's new.txt"), 'n\n');
        writeFileSync(join(repo, 'keep.txt'), 'changed\n');
        writeFileSync(join(repo, 'staged-other.txt'), 's\n');
        git('add staged-other.txt');

        const status = parseStatusSummaryV2(git('-c core.quotepath=false status --porcelain=v2 --branch --untracked-files=all'));
        const staged = status.files.filter((f) => f.index !== '.' && f.index !== '?').map((f) => ({ fullPath: f.path, oldPath: f.from, status: (f.index === 'R' ? 'renamed' : f.index === 'D' ? 'deleted' : 'modified') as 'renamed' | 'deleted' | 'modified' }));
        const unstaged = [
            ...status.files.filter((f) => f.working_dir !== '.').map((f) => ({ fullPath: f.path, status: 'modified' as const })),
            ...status.not_added.map((p) => ({ fullPath: p, status: 'untracked' as const })),
        ];
        const candidates = commitCandidates({ stagedFiles: staged, unstagedFiles: unstaged }).filter((c) => c.path !== 'staged-other.txt' && c.path !== 'keep.txt');
        const cmd = buildCommitCommand({ files: candidates, all: false, message: "feat: it's here\n\nbody", flavor: 'posix' });
        if (!cmd.ok) throw new Error(cmd.reason);
        const res = await sh(cmd.command, repo);
        expect(res.stderr).toBe('');
        expect(res.code).toBe(0);
        const show = git('show --name-status --format=%B HEAD');
        expect(show).toContain("feat: it's here\n\nbody");
        expect(show).toMatch(/R100\told\.txt\tnew\.txt/);
        expect(show).toMatch(/D\tgone\.txt/);
        expect(show).toContain("it's new.txt");
        expect(show).not.toContain('staged-other.txt');
        const after = git('status --porcelain');
        expect(after).toContain('A  staged-other.txt');
        expect(after).toContain(' M keep.txt');
    });

    it('probe sees the branch, no upstream yet, default branch main', async () => {
        const probe = parseProbe((await sh(buildProbeCommand('posix').ok ? (buildProbeCommand('posix') as { command: string }).command : '', repo)).stdout)!;
        expect(probe).toMatchObject({ branch: 'feat/x', upstream: null, defaultBranches: { origin: 'main' } });
        expect(probe.lastCommitMessage).toBe("feat: it's here\n\nbody");
    });

    it('push as a background job: first push sets upstream; pre-push hook failure reported with exit code + output', async () => {
        const push = buildPushCommand({ upstream: null, remotes: ['origin'], flavor: 'posix' });
        if (!push.ok) throw new Error(push.reason);
        const run = async (body: string) => {
            const start = await sh(buildJobStart(body), repo);
            const dir = parseJobStart(start.stdout);
            expect(dir).toBeTruthy();
            const poll = buildJobPoll(dir!);
            if (!poll.ok) throw new Error('poll');
            for (let i = 0; i < 100; i++) {
                const state = parseJobPoll((await sh(poll.command, repo)).stdout);
                if (state?.state === 'done') {
                    expect(existsSync(dir!)).toBe(false);
                    return state;
                }
                await new Promise((r) => setTimeout(r, 100));
            }
            throw new Error('job never finished');
        };
        const ok = await run(push.command);
        expect(ok.exitCode).toBe(0);
        expect(git('rev-parse --abbrev-ref --symbolic-full-name @{u}').trim()).toBe('origin/feat/x');

        mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
        const hook = join(repo, '.git', 'hooks', 'pre-push');
        writeFileSync(hook, '#!/bin/sh\necho "lint: 2 errors in a.ts" >&2\nexit 3\n');
        chmodSync(hook, 0o755);
        writeFileSync(join(repo, 'more.txt'), 'm\n');
        git('add more.txt');
        git('commit -q -m more');
        const again = buildPushCommand({ upstream: 'origin/feat/x', remotes: ['origin'], flavor: 'posix' });
        if (!again.ok) throw new Error(again.reason);
        const failed = await run(again.command);
        expect(failed.exitCode).not.toBe(0);
        expect(failed.output).toContain('lint: 2 errors in a.ts');
        unlinkSync(hook);
    });
});
