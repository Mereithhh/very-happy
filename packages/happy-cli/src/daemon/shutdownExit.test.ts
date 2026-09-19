import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { daemonExitCode } from './shutdownExit';

/**
 * B-477 regression: the daemon exited 0 after an unhandled rejection, so
 * launchd's `KeepAlive = {SuccessfulExit: false}` read the crash as a clean
 * stop and never relaunched. mac-office stayed offline for 25 hours.
 */
describe('daemonExitCode', () => {
    it('reports failure for an exception-sourced shutdown', () => {
        expect(daemonExitCode('exception')).toBe(1);
    });

    it.each(['happy-app', 'happy-cli', 'os-signal'] as const)('reports success for a %s shutdown', source => {
        expect(daemonExitCode(source)).toBe(0);
    });
});

describe('daemon run wiring', () => {
    const source = readFileSync(join(__dirname, 'run.ts'), 'utf-8');

    it('exits through daemonExitCode after cleanup instead of a hard-coded 0', () => {
        expect(source).toContain('process.exit(daemonExitCode(source));');
        expect(source).not.toContain("logger.debug('[DAEMON RUN] Cleanup completed, exiting process');\n      process.exit(0);");
    });

    it('forces the same code when the shutdown timer fires', () => {
        expect(source.match(/process\.exit\(daemonExitCode\(source\)\);/g)).toHaveLength(2);
    });

    // `requestShutdown('exception', …)` appears in both fatal handlers, so assert
    // each one inside its own block: a plain toContain stays green when only one
    // of them is broken.
    it.each([
        ['uncaughtException', "process.on('uncaughtException'"],
        ['unhandledRejection', "process.on('unhandledRejection'"],
    ])('routes %s to the exception source', (_label, anchor) => {
        const start = source.indexOf(anchor);
        expect(start).toBeGreaterThan(-1);
        expect(source.slice(start, start + 600)).toContain("requestShutdown('exception', error.message);");
    });
});
