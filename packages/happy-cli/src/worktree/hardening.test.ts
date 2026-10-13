/**
 * B-585 security review regressions — all on the real filesystem / real git /
 * real processes (no mocks of the code under test).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkIntoWorktree } from './materialize';
import { WorktreeService } from './service';
import { WorktreeStore } from './store';
import { prepareRunner, sanitizeSetupEnv, startSetupRun } from './setupRunner';

let base: string;
let repo: string;
let home: string;
const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=wt', '-c', 'user.email=wt@example.invalid', ...args], { stdio: 'pipe' }).toString();
const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'vh-wt-hard-')));
    repo = join(base, 'repo'); home = join(base, 'home');
    mkdirSync(repo); mkdirSync(home);
    git(repo, ['init', '-b', 'main']);
    writeFileSync(join(repo, 'README.md'), 'x');
    git(repo, ['add', '.']); git(repo, ['commit', '-m', 'init']);
});
afterEach(() => { try { chmodSync(join(base, 'locked'), 0o755); } catch { /* none */ } rmSync(base, { recursive: true, force: true }); });

const service = (extra: Partial<ConstructorParameters<typeof WorktreeService>[0]> = {}) => new WorktreeService({ home, machineId: 'm1', env: { PATH: process.env.PATH }, ...extra });

describe.skipIf(process.platform === 'win32')('B-585 review hardening', () => {
    it('中2: a link entry escaping through an intermediate symlink is refused (a -> ../outside)', async () => {
        const outside = join(base, 'outside'); mkdirSync(join(outside, 'b'), { recursive: true });
        execFileSync('ln', ['-s', '../outside', join(repo, 'a')]);
        const tree = join(base, 'tree'); mkdirSync(tree);
        const result = await linkIntoWorktree(repo, tree, ['a/b']);
        expect(result.linked).toEqual([]);
        expect(result.skipped).toEqual([{ path: 'a/b', reason: 'outside-repo' }]);
        expect(existsSync(join(tree, 'a'))).toBe(false);
    });

    it('中2: an in-repo link points at the checked REAL path', async () => {
        mkdirSync(join(repo, 'real/deps'), { recursive: true });
        execFileSync('ln', ['-s', 'real', join(repo, 'alias')]);
        const tree = join(base, 'tree'); mkdirSync(tree);
        const result = await linkIntoWorktree(repo, tree, ['alias/deps']);
        expect(result.linked).toEqual(['alias/deps']);
        expect(readlinkSync(join(tree, 'alias/deps'))).toBe(join(repo, 'real/deps'));
    });

    it('中3: .git segments and mkdir failures are skipped, never thrown', async () => {
        mkdirSync(join(repo, 'x/y'), { recursive: true });
        const tree = join(base, 'tree'); mkdirSync(tree);
        writeFileSync(join(tree, 'x'), 'tracked file where a dir would go');
        const result = await linkIntoWorktree(repo, tree, ['.git/hooks', 'x/y']);
        expect(result.linked).toEqual([]);
        expect(result.skipped.map((s) => s.reason)).toEqual(['git-internal', expect.stringMatching(/^(outside-worktree|link-failed)/)]);
    });

    it('中3: a failing initialization still registers the worktree (removable) with initError', async () => {
        const svc = service();
        const tree = join(base, 'tree'); git(repo, ['worktree', 'add', '-b', 'w', tree]);
        const record = await svc.initialize({ source: join(base, 'gone'), worktree: tree, branch: 'w', baseRef: null, origin: 'web' });
        expect(record.initError).toMatch(/^copy:/);
        expect(svc.store.get(realpathSync(tree))).toBeTruthy();
        // and the web can still see it
        expect(svc.status(tree)).toMatchObject({ tracked: true, initError: expect.stringMatching(/^copy:/) });
    });

    it('中4: output beyond the cap kills the group and marks truncated', async () => {
        const dir = join(base, 'run'); mkdirSync(dir);
        const launch = prepareRunner(dir, 'posix-sh', 'while true; do echo 0123456789012345678901234567890123456789; done');
        const outcome = await startSetupRun({ launch, cwd: dir, env: sanitizeSetupEnv(process.env, { worktree: dir, root: dir }), logPath: join(dir, 'out.log'), timeoutMs: 20_000, maxLogBytes: 64 * 1024 }).done;
        expect(outcome).toMatchObject({ state: 'failed', truncated: true });
    });

    it('低5: shorthand branch names that check-ref-format expands (@{-1}) are refused', async () => {
        git(repo, ['checkout', '-b', 'other']); git(repo, ['checkout', 'main']);
        await expect(service().create({ path: repo, branch: '@{-1}', baseRef: 'main', location: join(base, 'x') })).rejects.toThrow('invalid-branch');
        expect(git(repo, ['branch', '--list']).includes('@')).toBe(false);
    });

    it('低6: a failed add leaves no branch/worktree behind; a lost-answer retry is idempotent', async () => {
        const locked = join(base, 'locked'); mkdirSync(locked); chmodSync(locked, 0o500);
        const svc = service();
        await expect(svc.create({ path: repo, branch: 'feat/a', baseRef: 'main', location: join(locked, 'wt') })).rejects.toThrow(/git-worktree-add-failed|EACCES/);
        expect(git(repo, ['branch', '--list', 'feat/a']).trim()).toBe('');
        chmodSync(locked, 0o755);
        const first = await svc.create({ path: repo, branch: 'feat/a', baseRef: 'main', location: join(locked, 'wt') });
        const again = await svc.create({ path: repo, branch: 'feat/a', baseRef: 'main', location: join(locked, 'wt') });
        expect(again).toMatchObject({ worktreePath: first.worktreePath, reused: true });
    });

    it('低7: changes after the confirm (new file or edited listed file) force a re-confirm', async () => {
        const svc = service();
        const location = join(base, 'wt-r');
        await svc.create({ path: repo, branch: 'r', baseRef: 'main', location });
        writeFileSync(join(location, 'a.txt'), 'one');
        const seen = await svc.inspect(location) as { dirtyFingerprint: string };
        writeFileSync(join(location, 'a.txt'), 'one-two-three');
        await expect(svc.remove(location, true, seen.dirtyFingerprint)).rejects.toThrow('changes-changed');
        expect(existsSync(location)).toBe(true);
        const fresh = await svc.inspect(location) as { dirtyFingerprint: string };
        await svc.remove(location, true, fresh.dirtyFingerprint);
        expect(existsSync(location)).toBe(false);
    });

    it('低8: a restarted daemon kills an orphaned setup group only when it is provably that run', async () => {
        const store = new WorktreeStore(home);
        const start = (runId: string) => {
            const dir = store.runDir(runId);
            const script = join(dir, 'setup.sh');
            writeFileSync(script, 'sleep 30\n');
            const child = spawn('/bin/sh', ['-e', script], { detached: true, stdio: 'ignore' });
            child.unref();
            return child.pid!;
        };
        const mine = start('r1');
        const stranger = start('r2');
        const rec = (pid: number, runId: string) => ({ repoRoot: repo, branch: 'b', baseRef: null, origin: 'web' as const, createdAt: Date.now(), copied: [], linked: [], skipped: [], setup: { state: 'running' as const, pid, runId } });
        store.put('/wt/1', rec(mine, 'r1'));
        // a record whose pid was reused by an unrelated process (command does not name the run)
        store.put('/wt/2', rec(stranger, 'r-other'));
        try {
            new WorktreeService({ home, machineId: 'm1' });
            await new Promise((r) => setTimeout(r, 200));
            expect(isAlive(mine)).toBe(false);
            expect(isAlive(stranger)).toBe(true);
            expect(new WorktreeStore(home).get('/wt/1')!.setup.state).toBe('interrupted');
        } finally {
            for (const pid of [mine, stranger]) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
        }
    });
});
