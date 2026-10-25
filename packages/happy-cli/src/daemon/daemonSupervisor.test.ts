import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { daemonLineage, detectDaemonSupervisor, handoverWaitsForSessions, kickstartLaunchdJob, parseSystemdUnit, probeLaunchdJob, probeSystemdKillMode, SYSTEMD_RESTART_HINT, wrappersSurviveHandover, type HandoverSurvivalEvidence } from './daemonSupervisor';
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

/**
 * B-817b regression (#762 review M1). B-817 let the handover leave mid-turn
 * once the bundle is replaced. `INVOCATION_ID` alone reads `systemd` for ANY
 * unit; a hand-written one has KillMode=control-group, and exit 75 SIGTERMs
 * every wrapper in the cgroup (the 2026-09-25 incident, now mid-turn after a
 * 15 min busy grace). Such hosts, and a container's init, keep the turn gate.
 */
describe('wrappersSurviveHandover (B-817b)', () => {
    const base: HandoverSurvivalEvidence = { supervisor: 'none', env: {}, platform: 'linux', pid: 4242, ppid: 4000, inContainer: false, systemdKillMode: null };
    const survives = (over: Partial<HandoverSurvivalEvidence>) => wrappersSurviveHandover({ ...base, ...over });

    it('a hand-written systemd unit (INVOCATION_ID only, default KillMode) keeps the gate', () => {
        const env = { INVOCATION_ID: 'abc' };
        expect(detectDaemonSupervisor(env, 'linux')).toBe('systemd');
        expect(survives({ supervisor: 'systemd', env, systemdKillMode: 'control-group' })).toBe(false);
        expect(survives({ supervisor: 'systemd', env, systemdKillMode: 'mixed' })).toBe(false);
        // KillMode unreadable and nothing explicit: unproven
        expect(survives({ supervisor: 'systemd', env, systemdKillMode: null })).toBe(false);
    });

    it('systemd skips the gate only with KillMode=process read back, or the explicit unit setting when unreadable', () => {
        expect(survives({ supervisor: 'systemd', env: { INVOCATION_ID: 'abc' }, systemdKillMode: 'process' })).toBe(true);
        expect(survives({ supervisor: 'systemd', env: { INVOCATION_ID: 'abc' }, systemdKillMode: 'none' })).toBe(true);
        expect(survives({ supervisor: 'systemd', env: { HAPPY_DAEMON_SUPERVISOR: 'systemd' }, systemdKillMode: null })).toBe(true);
        // a read-back control-group beats a copied env line
        expect(survives({ supervisor: 'systemd', env: { HAPPY_DAEMON_SUPERVISOR: 'systemd' }, systemdKillMode: 'control-group' })).toBe(false);
    });

    it('launchd and a plain shell daemon spare the wrappers', () => {
        expect(survives({ supervisor: 'launchd', platform: 'darwin' })).toBe(true);
        expect(survives({ supervisor: 'none' })).toBe(true);
        expect(survives({ supervisor: 'none', platform: 'darwin' })).toBe(true);
        // ppid 1 outside a container is an ordinary re-parented daemon
        expect(survives({ supervisor: 'none', ppid: 1 })).toBe(true);
    });

    it('a container init (PID 1, or the direct child of tini) and unverified Windows keep the gate', () => {
        expect(survives({ supervisor: 'none', pid: 1 })).toBe(false);
        expect(survives({ supervisor: 'none', inContainer: true, ppid: 1 })).toBe(false);
        expect(survives({ supervisor: 'none', inContainer: true, ppid: 77 })).toBe(true);
        expect(survives({ supervisor: 'none', platform: 'win32' })).toBe(false);
    });
});

describe('handoverWaitsForSessions (B-817/B-817b)', () => {
    it('only a replaced bundle with a wrapper-sparing exit and no relay move leaves mid-turn', () => {
        expect(handoverWaitsForSessions({ bundleReplaced: true, relayMove: false, sparesWrappers: true })).toBe(false);
        expect(handoverWaitsForSessions({ bundleReplaced: true, relayMove: false, sparesWrappers: false })).toBe(true);
        expect(handoverWaitsForSessions({ bundleReplaced: false, relayMove: true, sparesWrappers: true })).toBe(true);
        // S5: a relay move coinciding with a replaced bundle keeps its gate
        expect(handoverWaitsForSessions({ bundleReplaced: true, relayMove: true, sparesWrappers: true })).toBe(true);
    });
});

describe('probeSystemdKillMode (B-817b)', () => {
    it('finds the owning unit in cgroup v2 and v1, user or system manager', () => {
        expect(parseSystemdUnit('0::/user.slice/user-1000.slice/user@1000.service/app.slice/very-happy-daemon.service\n'))
            .toEqual({ unit: 'very-happy-daemon.service', user: true });
        expect(parseSystemdUnit('0::/system.slice/happy.service')).toEqual({ unit: 'happy.service', user: false });
        expect(parseSystemdUnit('12:pids:/x\n1:name=systemd:/system.slice/run-r3f.service\n')).toEqual({ unit: 'run-r3f.service', user: false });
        // a login session / shell scope is no unit of ours
        expect(parseSystemdUnit('0::/user.slice/user-1000.slice/session-4.scope')).toBeNull();
        expect(parseSystemdUnit('0::/user.slice/user-1000.slice/user@1000.service/app.slice/tmux-spawn-1.scope')).toBeNull();
        expect(parseSystemdUnit('0::/')).toBeNull();
    });

    it('asks the right manager for KillMode; anything else reads as unknown', async () => {
        const calls: string[][] = [];
        const exec = async (file: string, args: string[]) => { calls.push([file, ...args]); return 'process\n'; };
        expect(await probeSystemdKillMode(async () => '0::/user.slice/user-1000.slice/user@1000.service/app.slice/vh.service', exec)).toBe('process');
        expect(calls).toEqual([['systemctl', '--user', 'show', '-p', 'KillMode', '--value', 'vh.service']]);
        expect(await probeSystemdKillMode(async () => '0::/system.slice/vh.service', async () => 'control-group')).toBe('control-group');
        expect(calls.length).toBe(1);
        expect(await probeSystemdKillMode(async () => '0::/system.slice/vh.service', async () => '')).toBeNull();
        expect(await probeSystemdKillMode(async () => { throw new Error('ENOENT'); }, exec)).toBeNull();
    });
});
