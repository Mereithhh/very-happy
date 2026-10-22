import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { daemonLineage, detectDaemonSupervisor, kickstartLaunchdJob, probeLaunchdJob, SYSTEMD_RESTART_HINT } from './daemonSupervisor';
import { HANDOVER_EXIT_CODE } from './shutdownExit';

/**
 * B-505 regression. dev-sg runs the daemon under a systemd user unit; the
 * 0.2.154 and 0.2.155 upgrades (`daemon stop` → unit exit → `KillMode=
 * control-group` SIGTERMs the cgroup) ended every session wrapper mid-turn,
 * and the auto-update self-handover would have done the same by exiting 0
 * with a replacement spawned from inside the unit.
 */
describe('detectDaemonSupervisor', () => {
    it('reads the explicit unit setting first', () => {
        expect(detectDaemonSupervisor({ HAPPY_DAEMON_SUPERVISOR: 'systemd' }, 'darwin')).toBe('systemd');
        expect(detectDaemonSupervisor({ HAPPY_DAEMON_SUPERVISOR: 'none', INVOCATION_ID: 'abc' }, 'linux')).toBe('none');
        expect(detectDaemonSupervisor({ HAPPY_DAEMON_SUPERVISOR: ' SystemD ' }, 'linux')).toBe('systemd');
    });

    it("recognises systemd's INVOCATION_ID on linux only", () => {
        expect(detectDaemonSupervisor({ INVOCATION_ID: '2f3c…' }, 'linux')).toBe('systemd');
        expect(detectDaemonSupervisor({ INVOCATION_ID: '' }, 'linux')).toBe('none');
        expect(detectDaemonSupervisor({ INVOCATION_ID: '2f3c…' }, 'darwin')).toBe('none');
    });

    it('a shell-started daemon is unsupervised (plain terminals on either OS)', () => {
        expect(detectDaemonSupervisor({}, 'linux')).toBe('none');
        expect(detectDaemonSupervisor({}, 'darwin', { jobPid: 100, ancestorPids: [500, 400] })).toBe('none');
        expect(detectDaemonSupervisor({ HAPPY_DAEMON_SUPERVISOR: 'launchd' }, 'darwin')).toBe('none');
    });
});

/**
 * B-770 regression. Release4 2026-10-22, both Macs: the B-718 auto-update
 * handover spawned the replacement daemon detached and exited 0; the new
 * daemon re-parented to PID 1 outside the job and the job read `not running`
 * (KeepAlive.SuccessfulExit=false), so a later crash would never be restarted.
 */
describe('detectDaemonSupervisor: launchd', () => {
    const env = { XPC_SERVICE_NAME: 'com.mereith.happy-daemon' };

    it('is launchd when the job pid is this process or an ancestor (bin shim)', () => {
        expect(detectDaemonSupervisor(env, 'darwin', { jobPid: 400, ancestorPids: [500, 400, 1] })).toBe('launchd');
        expect(detectDaemonSupervisor(env, 'darwin', { jobPid: 500, ancestorPids: [500, 1] })).toBe('launchd');
    });

    it('never from the environment alone: the escaped daemon of the old handover still carries XPC_SERVICE_NAME', () => {
        // job not running (no pid), or running as somebody else
        expect(detectDaemonSupervisor(env, 'darwin', { jobPid: null, ancestorPids: [500] })).toBe('none');
        expect(detectDaemonSupervisor(env, 'darwin', { jobPid: 999, ancestorPids: [500] })).toBe('none');
        expect(detectDaemonSupervisor(env, 'darwin', null)).toBe('none');
        expect(detectDaemonSupervisor({ XPC_SERVICE_NAME: 'application.com.apple.Terminal.1' }, 'darwin', { jobPid: 400, ancestorPids: [500, 400] })).toBe('none');
        expect(detectDaemonSupervisor(env, 'linux', { jobPid: 400, ancestorPids: [400] })).toBe('none');
    });

    it('an explicit none still wins', () => {
        expect(detectDaemonSupervisor({ ...env, HAPPY_DAEMON_SUPERVISOR: 'none' }, 'darwin', { jobPid: 400, ancestorPids: [400] })).toBe('none');
    });

    it('probes launchctl for the job pid and walks this process up its ancestors', async () => {
        const calls: string[][] = [];
        const parents = new Map<number, number>([[process.ppid, 4242], [4242, 1]]);
        const evidence = await probeLaunchdJob(async (file, args) => {
            calls.push([file, ...args]);
            if (file === 'launchctl') return '\tstate = running\n\tpid = 4242\n';
            return `${parents.get(Number(args[args.length - 1])) ?? 1}\n`;
        });
        expect(evidence.jobPid).toBe(4242);
        expect(evidence.ancestorPids.slice(0, 3)).toEqual([process.pid, process.ppid, 4242]);
        expect(calls[0]).toEqual(['launchctl', 'print', `gui/${process.getuid!()}/com.mereith.happy-daemon`]);
    });

    it('a failed launchctl (not loaded, not darwin) reads as no job', async () => {
        const evidence = await probeLaunchdJob(async () => '');
        expect(evidence.jobPid).toBeNull();
        expect(detectDaemonSupervisor(env, 'darwin', evidence)).toBe('none');
    });
});

describe('daemonLineage (B-770: machine page agrees with state.supervisor)', () => {
    it('a supervisor is the lineage, on linux too', () => {
        expect(daemonLineage('systemd', { INVOCATION_ID: 'x' }, 'linux')).toBe('systemd');
        expect(daemonLineage('launchd', { XPC_SERVICE_NAME: 'com.mereith.happy-daemon' }, 'darwin', { jobPid: 1, ancestorPids: [2, 1] })).toBe('launchd');
    });

    it('unsupervised keeps the B-276 darwin classification', () => {
        expect(daemonLineage('none', {}, 'linux')).toBe('other');
        expect(daemonLineage('none', { XPC_SERVICE_NAME: 'com.mereith.happy-daemon' }, 'darwin', { jobPid: null, ancestorPids: [5] })).toBe('inherited-env');
        expect(daemonLineage('none', {}, 'darwin', null)).toBe('other');
    });

    it('agrees with detectDaemonSupervisor for every launchd case', () => {
        const env = { XPC_SERVICE_NAME: 'com.mereith.happy-daemon' };
        for (const evidence of [{ jobPid: 4, ancestorPids: [5, 4] }, { jobPid: null, ancestorPids: [5] }, { jobPid: 9, ancestorPids: [5] }]) {
            const supervisor = detectDaemonSupervisor(env, 'darwin', evidence);
            expect(daemonLineage(supervisor, env, 'darwin', evidence) === 'launchd').toBe(supervisor === 'launchd');
        }
    });
});

describe('daemon run wiring (B-505 systemd / B-770 launchd handover)', () => {
    const run = readFileSync(join(__dirname, 'run.ts'), 'utf8');
    const index = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');
    const unit = readFileSync(join(__dirname, '..', '..', '..', '..', 'ops', 'dev-sg', 'very-happy-daemon.service'), 'utf8');

    it('detects the supervisor once and records it in the daemon state', () => {
        expect(run).toContain('const daemonSupervisor = detectDaemonSupervisor(process.env, process.platform, launchdJob);');
        expect(run).toContain('supervisor: daemonSupervisor,');
        // the machine page's lineage comes from the same evidence
        expect(run).toContain('const lineage = daemonLineage(daemonSupervisor, process.env, process.platform, launchdJob);');
        expect(run).toMatch(/new ClaudeAuthService\(\{[\s\S]*?\n      lineage,\n    \}\);/);
    });

    it('any supervised daemon (launchd or systemd) exits HANDOVER_EXIT_CODE after releasing ownership, before any spawn', () => {
        const release = run.indexOf('await releaseDaemonLock(daemonLockHandle);\n        await stopCaffeinate();');
        const gate = run.indexOf("if (daemonSupervisor !== 'none') {");
        const spawn = run.indexOf("spawnHappyCLI(['daemon', 'start'], {");
        expect(release).toBeGreaterThan(-1);
        expect(gate).toBeGreaterThan(release);
        expect(spawn).toBeGreaterThan(gate);
        expect(run.slice(gate, spawn)).toContain('process.exit(HANDOVER_EXIT_CODE);');
    });

    it('the handover code is non-zero so Restart=on-failure restarts the unit, and not the crash code', () => {
        expect(HANDOVER_EXIT_CODE).toBe(75);
    });

    it('`daemon start` refuses to replace a systemd-owned daemon and points at the unit', () => {
        const start = index.indexOf("} else if (daemonSubcommand === 'start') {");
        const body = index.slice(start, index.indexOf("} else if (daemonSubcommand === 'start-sync') {"));
        const guard = body.indexOf("if (currentState?.supervisor === 'systemd') {");
        expect(guard).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(body.indexOf('await stopDaemon()'));
        expect(body.slice(guard, guard + 400)).toContain('SYSTEMD_RESTART_HINT');
        expect(body.slice(guard, guard + 400)).toContain('process.exit(1)');
        expect(SYSTEMD_RESTART_HINT).toBe('systemctl --user restart very-happy-daemon');
    });

    it('`daemon start` hands a launchd-owned daemon back to its job instead of spawning one outside it', () => {
        const start = index.indexOf("} else if (daemonSubcommand === 'start') {");
        const body = index.slice(start, index.indexOf("} else if (daemonSubcommand === 'start-sync') {"));
        const stop = body.indexOf('await stopDaemon()');
        const handed = body.indexOf("const handedToLaunchd = running && !currentDaemonMatches && currentState?.supervisor === 'launchd' && await kickstartLaunchdJob()");
        const spawn = body.indexOf("spawnHappyCLI(['daemon', 'start-sync'], {");
        expect(stop).toBeGreaterThan(-1);
        expect(handed).toBeGreaterThan(stop);
        expect(spawn).toBeGreaterThan(handed);
        // the spawn is the fallback branch only
        expect(body.slice(handed, spawn)).toMatch(/if \(handedToLaunchd\) \{[\s\S]*\} else \{/);
    });

    it('kickstart waits for the shim to leave the job, is the plain re-adopt (never -k), and reports failure as false', async () => {
        const calls: string[][] = [];
        let listed = 2;
        const run = (file: string, args: string[]) => {
            calls.push([file, ...args]);
            if (args[0] === 'print') return { status: 0, stdout: listed-- > 0 ? '\tpid = 77\n' : '\tstate = not running\n' };
            return { status: 0 };
        };
        expect(await kickstartLaunchdJob(run, 501, async () => {})).toBe(true);
        expect(calls.filter((c) => c[1] === 'print')).toHaveLength(3);
        expect(calls[calls.length - 1]).toEqual(['launchctl', 'kickstart', 'gui/501/com.mereith.happy-daemon']);
        // job not loaded at all → fall back to the old spawn
        expect(await kickstartLaunchdJob(() => ({ status: 113, stdout: '' }), 501, async () => {})).toBe(false);
        expect(await kickstartLaunchdJob((_f, args) => args[0] === 'print' ? { status: 0, stdout: '' } : { status: 5 }, 501, async () => {})).toBe(false);
        expect(await kickstartLaunchdJob(() => { throw new Error('ENOENT'); }, 501, async () => {})).toBe(false);
        expect(await kickstartLaunchdJob(() => ({ status: 0 }), null, async () => {})).toBe(false);
    });

    it('a shell `daemon start` never passes a supervisor claim to the detached daemon', () => {
        const start = index.indexOf("} else if (daemonSubcommand === 'start') {");
        const body = index.slice(start, index.indexOf("} else if (daemonSubcommand === 'start-sync') {"));
        expect(body).toContain('const { HAPPY_DAEMON_SUPERVISOR: _supervisor, INVOCATION_ID: _invocation, ...detachedEnv } = process.env;');
        expect(body).toContain('env: detachedEnv');
        expect(body).not.toContain('env: process.env');
    });

    it('the shipped LaunchAgent restarts the handover code and the bin shim passes it through', () => {
        const ops = join(__dirname, '..', '..', '..', '..', 'ops', 'mac-office');
        const installer = readFileSync(join(ops, 'install-launch-agent.sh'), 'utf8');
        const wrapper = readFileSync(join(ops, 'happy-daemon-launch.sh'), 'utf8');
        const shim = readFileSync(join(__dirname, '..', '..', 'bin', 'very-happy.mjs'), 'utf8');
        expect(installer).toContain('"KeepAlive": {"SuccessfulExit": False},');
        expect(installer).toContain('"Label": "com.mereith.happy-daemon",');
        // the job's pid is the shim; the daemon's 75 must reach launchd unchanged
        expect(shim).toContain('process.exit(error.status || 1);');
        // the handover released daemon.state.json, so the wrapper starts instead of "leaving it alone"
        expect(wrapper).toMatch(/if \[ -f "\$STATE" \]; then/);
        expect(wrapper.trimEnd().endsWith('exec very-happy daemon start-sync')).toBe(true);
    });

    it('the shipped unit keeps wrappers alive across a daemon exit and restarts on the handover code', () => {
        // directive lines, not the comments that explain them
        expect(unit).toMatch(/^KillMode=process$/m);
        expect(unit).toMatch(/^Restart=on-failure$/m);
        expect(unit).toMatch(/^Environment=HAPPY_DAEMON_SUPERVISOR=systemd$/m);
        // the bin shim must not re-exec into a child: systemd's main PID has to
        // be the daemon itself, or KillMode=process signals only the shim.
        expect(unit).toMatch(/ExecStart=.*node --no-warnings --no-deprecation .*very-happy daemon start-sync/);
    });
});
