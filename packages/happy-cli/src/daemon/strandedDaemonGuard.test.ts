import { describe, expect, it, vi } from 'vitest';
import { detectStrandedDaemon, guardStrandedPreflight, isHandoverPreflight, reviveSupervisor } from './strandedDaemonGuard';

const UNIT_CGROUP = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/very-happy-daemon.service\n';
const DAEMON_CMD = 'node\0--no-warnings\0/x/dist/index.mjs\0daemon\0start-sync\0';
const PREFLIGHT_ENV = { HAPPY_HOME_DIR: '/tmp/vh-preflight-abc123', HAPPY_DAEMON_SUPERVISOR: 'systemd', INVOCATION_ID: 'x' };

function linux(mainPid: string, opts: { cgroup?: string; cmd?: string; env?: NodeJS.ProcessEnv; showStatus?: number } = {}) {
    const calls: string[][] = [];
    const runFn = vi.fn((file: string, args: string[]) => {
        calls.push([file, ...args]);
        if (args.includes('show')) return { status: opts.showStatus ?? 0, stdout: `${mainPid}\n` };
        return { status: 0 };
    });
    const deps = {
        platform: 'linux' as const,
        env: opts.env ?? PREFLIGHT_ENV,
        ppid: 4242,
        readFile: (path: string) => (path.endsWith('/cmdline') ? opts.cmd ?? DAEMON_CMD : opts.cgroup ?? UNIT_CGROUP),
        run: runFn,
    };
    return { deps, calls };
}

describe('a daemon that left its unit is repaired by the new bundle\'s preflight (B-965)', () => {
    it('recognises only the handover preflight of a daemon process', () => {
        expect(isHandoverPreflight(PREFLIGHT_ENV, DAEMON_CMD)).toBe(true);
        expect(isHandoverPreflight({ HAPPY_HOME_DIR: '/home/u/.happy' }, DAEMON_CMD)).toBe(false);
        expect(isHandoverPreflight(PREFLIGHT_ENV, 'node\0/x/dist/index.mjs\0codex\0')).toBe(false);
    });

    it('linux: unit inactive (MainPID 0) while the daemon sits in its cgroup → start the unit, hold the handover', () => {
        const { deps, calls } = linux('0');
        expect(detectStrandedDaemon(deps)).toEqual({ kind: 'systemd', unit: 'very-happy-daemon.service', user: true, mainPid: null });
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(guardStrandedPreflight(deps)).toBe(3);
        err.mockRestore();
        expect(calls).toContainEqual(['systemctl', '--user', '--no-block', 'start', 'very-happy-daemon.service']);
    });

    it('linux: the daemon IS the unit\'s main process → answer normally (no start, exit code untouched)', () => {
        const { deps, calls } = linux('4242');
        expect(detectStrandedDaemon(deps)).toBeNull();
        expect(guardStrandedPreflight(deps)).toBeNull();
        expect(calls.some((c) => c.includes('start'))).toBe(false);
    });

    it('linux: not a preflight, no systemd claim, no unit cgroup, or systemctl unreadable → behave as before', () => {
        expect(detectStrandedDaemon(linux('0', { env: { ...PREFLIGHT_ENV, HAPPY_HOME_DIR: '/home/u/.happy' } }).deps)).toBeNull();
        expect(detectStrandedDaemon(linux('0', { env: { HAPPY_HOME_DIR: '/tmp/vh-preflight-1' } }).deps)).toBeNull();
        expect(detectStrandedDaemon(linux('0', { cgroup: '0::/user.slice/user-1000.slice/session-4.scope\n' }).deps)).toBeNull();
        expect(detectStrandedDaemon(linux('0', { showStatus: 1 }).deps)).toBeNull();
    });

    it('linux: a unit already active with another main process is left alone but the handover is still held', () => {
        const { deps, calls } = linux('9999');
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(guardStrandedPreflight(deps)).toBe(3);
        err.mockRestore();
        expect(calls.some((c) => c.includes('start'))).toBe(false);
    });

    it('darwin: job with no running process and the daemon carrying its label → kickstart', () => {
        const calls: string[][] = [];
        const runFn = (file: string, args: string[]) => {
            calls.push([file, ...args]);
            if (file === 'ps') return { status: 0, stdout: 'node /x/dist/index.mjs daemon start-sync\n' };
            if (args[0] === 'print') return { status: 0, stdout: 'state = not running\n' };
            return { status: 0 };
        };
        const deps = { platform: 'darwin' as const, env: { HAPPY_HOME_DIR: '/var/folders/x/vh-preflight-q', XPC_SERVICE_NAME: 'com.mereith.happy-daemon' }, ppid: 7, uid: 501, run: runFn };
        expect(detectStrandedDaemon(deps)).toEqual({ kind: 'launchd', target: 'gui/501/com.mereith.happy-daemon' });
        expect(reviveSupervisor({ kind: 'launchd', target: 'gui/501/com.mereith.happy-daemon' }, runFn)).toBe(true);
        expect(calls).toContainEqual(['launchctl', 'kickstart', 'gui/501/com.mereith.happy-daemon']);
        const running = { ...deps, run: (file: string, args: string[]) => (file === 'ps' ? { status: 0, stdout: 'daemon start-sync' } : args[0] === 'print' ? { status: 0, stdout: '\tpid = 812\n' } : { status: 0 }) };
        expect(detectStrandedDaemon(running)).toBeNull();
    });

    it('the entry stub runs the guard only for a preflight --version, before the self-check', async () => {
        const { readFile } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const src = await readFile(join(__dirname, '..', 'index.ts'), 'utf8');
        const guard = src.indexOf('guardStrandedPreflight()');
        expect(guard).toBeGreaterThan(0);
        expect(guard).toBeLessThan(src.indexOf("await import('./selfCheck')"));
        expect(src).toContain("if (isStandaloneVersionRequest(args) && /(^|[\\\\/])vh-preflight-[^\\\\/]*$/.test(process.env.HAPPY_HOME_DIR ?? '')) {");
    });
});
