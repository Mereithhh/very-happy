import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// B-689 wiring (source assertions; the pure pieces — startupExit,
// startupSessionCreate, teams/spawnRetry — have behavioural tests).
const strip = (source: string) => source.replace(/^\s*\/\/.*$/gm, '');
const run = strip(readFileSync(join(__dirname, 'run.ts'), 'utf8'));
const awaiter = run.slice(run.indexOf('const spawnTrackedHappyProcess = ('), run.indexOf('const findTrackedSessionById'));

describe('daemon spawn awaiter (B-689)', () => {
    it('settles on the child exit with its real cause instead of waiting for the webhook timeout', () => {
        expect(awaiter).toContain("happyProcess.once('exit', (code, signal) => fail({ exited: true, code, signal }));");
        expect(awaiter).toContain('startupExit.reason ??= readStartupExitReason(configuration.logsDir, pid);');
        expect(awaiter).toContain("resolve({ type: 'error', errorMessage, startupExit });");
    });
    it('reports a timed-out wrapper as gone only after it is confirmed stopped', () => {
        expect(awaiter).toContain('terminateProcess(pid, (stopped) => fail({ exited: stopped, code: null, signal: null, timedOut: true }))');
    });
});

describe('daemon-spawned runners never go offline (B-689)', () => {
    for (const [file, flavor] of [['../claude/runClaude.ts', 'options'], ['../codex/runCodex.ts', 'opts'], ['../agent/acp/runAcp.ts', 'opts']] as const) {
        it(`${file} creates the session through createSessionForStartup`, () => {
            const source = strip(readFileSync(join(__dirname, file), 'utf8'));
            expect(source).toContain(`response = await createSessionForStartup(() => api.getOrCreateSession({ tag: sessionTag, metadata, state }), { startedBy: ${flavor}.startedBy,`);
        });
    }
    it('main records the reason of every command failure in the log file', () => {
        const main = strip(readFileSync(join(__dirname, '../main.ts'), 'utf8'));
        expect(main).toContain('installExitReasonFallback()');
        const fail = main.slice(main.indexOf('function failCommand('));
        expect(fail).toContain('recordExitReason(1, errorReason(error))');
    });
});
