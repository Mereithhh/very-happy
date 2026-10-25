import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// B-817: a busy machine upgrades. Verified with scripts/dev/mutation-check.mjs (see PR).
const run = readFileSync(join(__dirname, '..', 'daemon', 'run.ts'), 'utf8');

describe('busy-machine upgrade wiring (B-817)', () => {
    it('the controller gets the staged installer, the harness fence and the env-tunable grace', () => {
        expect(run).toContain('const report = await installCliStaged(version);');
        expect(run).toContain('return report.outcome;');
        expect(run).toContain('busyGraceMs: resolveBusyInstallGrace(process.env.HAPPY_CLI_UPDATE_BUSY_GRACE_MS),');
    });
    it('the classic in-place install stays the idle path', () => {
        expect(run).toContain('install: installCliSafely,');
    });
    it('a replaced bundle hands over regardless of turns only when the exit spares the wrappers; a relay move still waits (B-817b)', () => {
        expect(run).toContain('const sessionsHold = () => handoverWaitsForSessions({ bundleReplaced, relayMove: !!relayMove, sparesWrappers: handoverSparesWrappers }) && (turnActivity.hasActiveTurn() || backgroundTasks.hasAny());');
        // probed once at startup from the real process, KillMode read back for systemd
        expect(run).toContain("const systemdKillMode = daemonSupervisor === 'systemd' ? await probeSystemdKillMode() : null;");
        expect(run).toContain('supervisor: daemonSupervisor, env: process.env, platform: process.platform, pid: process.pid, ppid: process.ppid,');
        expect(run).toContain("inContainer: existsSync('/.dockerenv') || existsSync('/run/.containerenv'), systemdKillMode,");
        expect(run).not.toMatch(/if \(\(bundleReplaced \|\| relayMove\)[^\n]*turnActivity\.hasActiveTurn\(\)/);
    });
});
