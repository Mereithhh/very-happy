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
    it('a replaced bundle hands over regardless of turns; a relay move still waits for them', () => {
        expect(run).toContain('const sessionsHold = () => !bundleReplaced && (turnActivity.hasActiveTurn() || backgroundTasks.hasAny());');
        expect(run).not.toMatch(/if \(\(bundleReplaced \|\| relayMove\)[^\n]*turnActivity\.hasActiveTurn\(\)/);
    });
});
