import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectDaemonSupervisor, SYSTEMD_RESTART_HINT } from './daemonSupervisor';
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

    it('a shell-started daemon is unsupervised (launchd hosts, plain terminals)', () => {
        expect(detectDaemonSupervisor({}, 'linux')).toBe('none');
        expect(detectDaemonSupervisor({ HAPPY_DAEMON_SUPERVISOR: 'launchd' }, 'darwin')).toBe('none');
    });
});

describe('daemon run wiring (B-505 systemd handover)', () => {
    const run = readFileSync(join(__dirname, 'run.ts'), 'utf8');
    const index = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8');
    const unit = readFileSync(join(__dirname, '..', '..', '..', '..', 'ops', 'dev-sg', 'very-happy-daemon.service'), 'utf8');

    it('detects the supervisor once and records it in the daemon state', () => {
        expect(run).toContain('const daemonSupervisor = detectDaemonSupervisor(process.env);');
        expect(run).toContain('supervisor: daemonSupervisor,');
    });

    it('a systemd-supervised daemon exits HANDOVER_EXIT_CODE after releasing ownership, before any spawn', () => {
        const release = run.indexOf('await releaseDaemonLock(daemonLockHandle);\n        await stopCaffeinate();');
        const gate = run.indexOf("if (daemonSupervisor === 'systemd') {");
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

    it('a shell `daemon start` never passes a supervisor claim to the detached daemon', () => {
        const start = index.indexOf("} else if (daemonSubcommand === 'start') {");
        const body = index.slice(start, index.indexOf("} else if (daemonSubcommand === 'start-sync') {"));
        expect(body).toContain('const { HAPPY_DAEMON_SUPERVISOR: _supervisor, INVOCATION_ID: _invocation, ...detachedEnv } = process.env;');
        expect(body).toContain('env: detachedEnv');
        expect(body).not.toContain('env: process.env');
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
