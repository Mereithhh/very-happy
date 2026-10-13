import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeService, WorktreeError, defaultWorktreeLocation, parsePorcelainZ, userDirtyPaths } from './service';
import { resolveSessionWorktree } from './sessionWorktree';

let base: string;
let repo: string;
let home: string;
const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=wt', '-c', 'user.email=wt@example.invalid', ...args], { stdio: 'pipe' }).toString();

function writeConfig(config: unknown) {
    mkdirSync(join(repo, '.veryhappy'), { recursive: true });
    writeFileSync(join(repo, '.veryhappy/worktree.json'), JSON.stringify(config));
}

async function waitFor<T>(fn: () => T, done: (v: T) => boolean, ms = 10_000): Promise<T> {
    const start = Date.now();
    for (;;) {
        const value = fn();
        if (done(value) || Date.now() - start > ms) return value;
        await new Promise((r) => setTimeout(r, 50));
    }
}

beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'vh-wt-svc-')));
    repo = join(base, 'repo'); home = join(base, 'home');
    mkdirSync(repo); mkdirSync(home);
    git(repo, ['init', '-b', 'main']);
    writeFileSync(join(repo, '.gitignore'), '.env*\nnode_modules\n');
    writeFileSync(join(repo, 'README.md'), 'x');
    git(repo, ['add', '.']); git(repo, ['commit', '-m', 'init']);
    writeFileSync(join(repo, '.env'), 'TOKEN=1');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const service = () => new WorktreeService({ home, machineId: 'm1', platform: process.platform === 'win32' ? 'win32' : 'linux', env: { PATH: process.env.PATH, HAPPY_SECRET: 'x' } });

describe.skipIf(process.platform === 'win32')('B-585/B-586 worktree service', () => {
    it('info reports branches, default parent and the default .env* config', async () => {
        const info = await service().info(repo);
        expect(info).toMatchObject({ repoRoot: repo, currentBranch: 'main', branches: ['main'], defaultParent: join(base, 'repo.worktrees') });
        expect(info.config).toMatchObject({ source: 'default', copy: ['.env*'], hasSetup: false });
    });

    it('creates a web worktree beside the repo, copies .env, needs approval, then runs exactly the approved bytes', async () => {
        writeConfig({ copy: ['.env'], setup: 'echo ran > setup-ran.txt\necho "secret=${HAPPY_SECRET:-none}"' });
        const svc = service();
        const location = defaultWorktreeLocation(repo, 'vh/swift-river');
        expect(location).toBe(join(base, 'repo.worktrees', 'vh-swift-river'));
        const created = await svc.create({ path: repo, branch: 'vh/swift-river', baseRef: 'main', location });
        expect(created.worktreePath).toBe(location);
        expect(created.init.copied).toEqual(['.env']);
        expect(created.init.setup.state).toBe('needs-approval');
        expect(readFileSync(join(location, '.env'), 'utf8')).toBe('TOKEN=1');
        expect(existsSync(join(location, 'setup-ran.txt'))).toBe(false);

        const status = svc.status(location);
        expect(status.tracked).toBe(true);
        const pending = (status as { pending?: { hash: string; script: string; cwd: string; changedSinceApproval: boolean } }).pending!;
        expect(pending.script).toContain('setup-ran.txt');
        expect(pending.cwd).toBe(location);
        expect(pending.changedSinceApproval).toBe(false);

        expect(() => svc.approve(location, 'deadbeef')).toThrow('script-changed');
        svc.approve(location, pending.hash);
        const finished = await waitFor(() => svc.store.get(location)!.setup.state, (s) => s !== 'running');
        expect(finished).toBe('succeeded');
        expect(existsSync(join(location, 'setup-ran.txt'))).toBe(true);
        const log = svc.log(location, 0);
        expect(log.text).toContain('secret=none');
        expect(log.done).toBe(true);
        // session metadata sees the linked worktree and its branch
        expect(resolveSessionWorktree(join(location))).toEqual({ branch: 'vh/swift-river', root: location });
        expect(resolveSessionWorktree(repo)).toBeNull();
    });

    it('a changed script needs approval again; an approved one runs automatically', async () => {
        writeConfig({ setup: 'echo one' });
        const svc = service();
        const first = await svc.create({ path: repo, branch: 'a', baseRef: 'main', location: join(base, 'wt-a') });
        expect(first.init.setup.state).toBe('needs-approval');
        svc.approve(join(base, 'wt-a'), (svc.status(join(base, 'wt-a')) as { pending: { hash: string } }).pending.hash);
        await waitFor(() => svc.store.get(join(base, 'wt-a'))!.setup.state, (s) => s !== 'running');

        const again = await svc.create({ path: repo, branch: 'b', baseRef: 'main', location: join(base, 'wt-b') });
        expect(again.init.setup.state).toBe('running');
        await waitFor(() => svc.store.get(join(base, 'wt-b'))!.setup.state, (s) => s !== 'running');

        writeConfig({ setup: 'echo two' });
        const changed = await svc.create({ path: repo, branch: 'c', baseRef: 'main', location: join(base, 'wt-c') });
        expect(changed.init.setup.state).toBe('needs-approval');
        expect((svc.status(join(base, 'wt-c')) as { pending: { changedSinceApproval: boolean } }).pending.changedSinceApproval).toBe(true);
        // approval is keyed by machine: another machine id never inherits it
        const other = new WorktreeService({ home, machineId: 'm2' });
        expect(other.store.isApproved('m2', repo, (svc.status(join(base, 'wt-c')) as { pending: { hash: string } }).pending.hash)).toBe(false);
    });

    it('declining leaves only the copied files', async () => {
        writeConfig({ copy: ['.env'], setup: 'touch should-not-exist' });
        const svc = service();
        const location = join(base, 'wt-d');
        await svc.create({ path: repo, branch: 'd', baseRef: 'main', location });
        const declined = svc.decline(location);
        expect((declined as { setup: { state: string } }).setup.state).toBe('declined');
        expect(existsSync(join(location, '.env'))).toBe(true);
        expect(existsSync(join(location, 'should-not-exist'))).toBe(false);
    });

    it('validates branch, base and location', async () => {
        const svc = service();
        await expect(svc.create({ path: repo, branch: 'bad..name', baseRef: 'main', location: join(base, 'x1') })).rejects.toThrow('invalid-branch');
        await expect(svc.create({ path: repo, branch: '-x', baseRef: 'main', location: join(base, 'x2') })).rejects.toThrow('invalid-branch');
        await expect(svc.create({ path: repo, branch: 'main', baseRef: 'main', location: join(base, 'x3') })).rejects.toThrow('branch-exists');
        await expect(svc.create({ path: repo, branch: 'ok', baseRef: 'nope', location: join(base, 'x4') })).rejects.toThrow('invalid-base');
        await expect(svc.create({ path: repo, branch: 'ok', baseRef: 'main', location: join(repo, 'nested') })).rejects.toThrow('location-inside-repo');
        await expect(svc.create({ path: repo, branch: 'ok', baseRef: 'main', location: 'relative/x' })).rejects.toThrow('invalid-path');
        await expect(svc.create({ path: repo, branch: 'ok', baseRef: 'main', location: repo })).rejects.toThrow('location-exists');
        expect(new WorktreeError('dirty').message).toBe('dirty');
    });

    it('teams/automation: explicit config only, never runs an unapproved script', async () => {
        const svc = service();
        const target = join(base, 'team-wt');
        git(repo, ['worktree', 'add', '-b', 'codex/team-1', target, 'HEAD']);
        const plain = await svc.initialize({ source: repo, worktree: target, branch: 'codex/team-1', baseRef: null, origin: 'teams' });
        expect(plain.copied).toEqual([]); // no .env* default for teams
        writeConfig({ copy: ['.env'], setup: 'touch ran' });
        const target2 = join(base, 'team-wt2');
        git(repo, ['worktree', 'add', '-b', 'codex/team-2', target2, 'HEAD']);
        const opted = await svc.initialize({ source: repo, worktree: target2, branch: 'codex/team-2', baseRef: null, origin: 'automation' });
        expect(opted.copied).toEqual(['.env']);
        expect(opted.setup.state).toBe('needs-approval');
        await new Promise((r) => setTimeout(r, 200));
        expect(existsSync(join(target2, 'ran'))).toBe(false);
        // owned by teams/automation → the web cannot delete it
        expect(await svc.inspect(target2)).toMatchObject({ removable: false, reason: 'owned-by-automation' });
    });

    it('remove: refuses user changes unless discarded, ignores own products, keeps the branch and the link target', async () => {
        writeConfig({ copy: ['.env'], link: ['node_modules'] });
        mkdirSync(join(repo, 'node_modules/pkg'), { recursive: true });
        writeFileSync(join(repo, 'node_modules/pkg/index.js'), 'keep');
        // node_modules is ignored in the commit; un-ignore so the link shows as untracked
        writeFileSync(join(repo, '.gitignore'), '.env\n'); git(repo, ['commit', '-am', 'ignore']);
        const svc = service();
        const location = join(base, 'wt-r');
        const created = await svc.create({ path: repo, branch: 'r', baseRef: 'main', location });
        expect(created.init.linked).toEqual(['node_modules']);
        expect(lstatSync(join(location, 'node_modules')).isSymbolicLink()).toBe(true);
        expect(await svc.inspect(location)).toMatchObject({ removable: true, dirtyCount: 0 });

        writeFileSync(join(location, 'work.txt'), 'wip');
        const dirty = await svc.inspect(location);
        expect(dirty).toMatchObject({ removable: true, dirtyCount: 1, dirty: ['work.txt'], branch: 'r' });
        await expect(svc.remove(location, false)).rejects.toThrow('dirty');
        expect(existsSync(location)).toBe(true);

        await svc.remove(location, true);
        expect(existsSync(location)).toBe(false);
        expect(readFileSync(join(repo, 'node_modules/pkg/index.js'), 'utf8')).toBe('keep');
        expect(git(repo, ['branch', '--list', 'r']).trim()).toContain('r');
        expect(svc.store.get(location)).toBeUndefined();
    });

    it('a restarted daemon records cut-off runs as interrupted', async () => {
        writeConfig({ setup: 'sleep 30' });
        const svc = service();
        const location = join(base, 'wt-i');
        await svc.create({ path: repo, branch: 'i', baseRef: 'main', location });
        svc.approve(location, (svc.status(location) as { pending: { hash: string } }).pending.hash);
        expect(svc.store.get(location)!.setup.state).toBe('running');
        svc.stopAll();
        const next = new WorktreeService({ home, machineId: 'm1' });
        expect(['interrupted']).toContain(next.store.get(location)!.setup.state);
    });
});

describe('porcelain helpers', () => {
    it('parses -z output with renames and filters own products', () => {
        const out = ' M a.txt\0R  new.txt\0old.txt\0?? .env\0?? node_modules/\0';
        expect(parsePorcelainZ(out)).toEqual(['a.txt', 'new.txt', '.env', 'node_modules']);
        expect(userDirtyPaths(parsePorcelainZ(out), { copied: ['.env'], linked: ['node_modules'] })).toEqual(['a.txt', 'new.txt']);
    });
});
