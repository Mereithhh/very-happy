import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWindowsRunnerScript, prepareRunner, sanitizeSetupEnv, startSetupRun } from './setupRunner';

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'vh-wt-run-'))); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function isAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('B-585 setup runner', () => {
    it('builds a fail-fast cmd runner (Orca shape)', () => {
        const text = buildWindowsRunnerScript('pnpm install\r\n\necho done!');
        expect(text.startsWith('@echo off\r\nsetlocal EnableExtensions DisableDelayedExpansion\r\n')).toBe(true);
        expect(text).toContain('call pnpm install\r\nif errorlevel 1 exit /b %errorlevel%\r\n');
        expect(text).toContain('call echo done!\r\n');
        expect(text).not.toMatch(/[^\r]\n/);
    });

    it('strips very-happy internals and adds only two path vars', () => {
        const env = sanitizeSetupEnv({ PATH: '/bin', HAPPY_SERVER_URL: 'x', VH_TEAM_SCOPE_FILE: '/s', happy_home_dir: 'y', HOME: '/h' }, { worktree: '/w', root: '/r' });
        expect(env).toEqual({ PATH: '/bin', HOME: '/h', VERY_HAPPY_WORKTREE_PATH: '/w', VERY_HAPPY_ROOT_PATH: '/r' });
    });

    it('prepares the runner per kind', () => {
        expect(prepareRunner(dir, 'posix-sh', 'true')).toMatchObject({ command: '/bin/sh', args: ['-e', join(dir, 'setup.sh')] });
        const shebang = prepareRunner(dir, 'shebang', '#!/bin/sh\ntrue');
        expect(shebang.command).toBe(join(dir, 'setup'));
        if (process.platform !== 'win32') expect(statSync(shebang.scriptPath).mode & 0o777).toBe(0o700);
        const cmd = prepareRunner(dir, 'cmd', 'echo hi');
        expect(cmd.args).toEqual(['/d', '/c', join(dir, 'setup.cmd')]);
        expect(readFileSync(cmd.scriptPath, 'utf8')).toContain('call echo hi');
    });

    it.skipIf(process.platform === 'win32')('runs in cwd with the sanitized env and logs to disk', async () => {
        const launch = prepareRunner(dir, 'posix-sh', 'pwd\necho "secret=${HAPPY_SECRET:-none}"\necho "wt=$VERY_HAPPY_WORKTREE_PATH"\nexit 3');
        const handle = startSetupRun({ launch, cwd: dir, env: sanitizeSetupEnv({ ...process.env, HAPPY_SECRET: 'leak' }, { worktree: dir, root: '/r' }), logPath: join(dir, 'out.log'), timeoutMs: 20_000 });
        const outcome = await handle.done;
        expect(outcome).toMatchObject({ state: 'failed', exitCode: 3 });
        const log = readFileSync(join(dir, 'out.log'), 'utf8');
        expect(log).toContain(dir);
        expect(log).toContain('secret=none');
        expect(log).toContain(`wt=${dir}`);
    });

    it.skipIf(process.platform === 'win32')('a timeout kills the whole process group', async () => {
        const pidFile = join(dir, 'bg.pid');
        const launch = prepareRunner(dir, 'posix-sh', `sleep 30 &\necho $! > "${pidFile}"\nwait`);
        const handle = startSetupRun({ launch, cwd: dir, env: sanitizeSetupEnv(process.env, { worktree: dir, root: dir }), logPath: join(dir, 'out.log'), timeoutMs: 400 });
        const outcome = await handle.done;
        expect(outcome.state).toBe('timed-out');
        const bg = Number(readFileSync(pidFile, 'utf8').trim());
        await new Promise((r) => setTimeout(r, 200));
        expect(isAlive(bg)).toBe(false);
    });

    it.skipIf(process.platform === 'win32')('stop() interrupts', async () => {
        const launch = prepareRunner(dir, 'posix-sh', 'sleep 30');
        const handle = startSetupRun({ launch, cwd: dir, env: sanitizeSetupEnv(process.env, { worktree: dir, root: dir }), logPath: join(dir, 'out.log'), timeoutMs: 60_000 });
        setTimeout(() => handle.stop(), 100);
        expect((await handle.done).state).toBe('interrupted');
    });
});
