/**
 * B-901 wiring guard: the decision is codexCrashLoop.ts (codexCrashLoop.test.ts)
 * and the exit facts are the client's (codexAppServerClient.test.ts); this pins
 * where runCodex uses them. Pinned with scripts/dev/mutation-check.mjs.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, './runCodex.ts'), 'utf8');
const section = (from: string, to: string) => {
    const start = source.indexOf(from);
    expect(start, from).toBeGreaterThan(-1);
    const end = source.indexOf(to, start);
    expect(end, to).toBeGreaterThan(start);
    return source.slice(start, end);
};

describe('Codex crash-loop wiring (B-901)', () => {
    it('records each unexpected app-server exit into session metadata', () => {
        const handler = section('client.setUnexpectedExitHandler((exit) => {', '});');
        expect(handler).toContain('recordCodexCrash(crashStreak(), exit, Date.now())');
        expect(handler).toContain('codexResumeCrash: next');
        // read back at once (the very next catch), so held locally — metadata lags a round trip
        expect(handler).toContain('crashStreakNow = next;');
        expect(source).toContain('const crashStreak = () => crashStreakNow;');
    });

    it('a blocked thread is not resumed at start', () => {
        const start = section('if (opts.resumeThreadId && !codexAccount.unavailable && isCrashLoopBlocked(', 'await resumeExistingThread({');
        expect(start).toContain('blockedResumeThreadId = opts.resumeThreadId;');
        expect(start).toContain('sendCrashLoopNotice();');
        expect(start).toContain('} else if (opts.resumeThreadId');
    });

    it('a message for a blocked thread never respawns Codex: tombstoned as failed, with the way out', () => {
        const loop = section('const compactCommand = codexCompactCommand(message.message);', 'await client.ensureConnected();');
        expect(loop).toMatch(/if \(crashLoopBlocked\(\)\) \{\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*heldInput\.drop\('failed'\);\n\s*sendCrashLoopNotice\(\);\n\s*continue;/);
    });

    it('a lost app-server says how it died, then the way out once blocked; a finished turn clears the streak', () => {
        const caught = section("logger.warn('Error in codex session'", '} finally {');
        expect(caught).toMatch(/session\.sendSessionEvent\(\{ type: 'message', message: processLossMessage\(error\) \}\);\n\s*logger\.debug\(`\[Codex\] Crash-loop check:[^\n]*\n\s*if \(crashLoopBlocked\(\)\) sendCrashLoopNotice\(\);/);
        expect(source).toContain('if (!result.aborted) clearCrashStreak();');
        expect(section("logger.debug('[Codex] Handling /clear command", 'currentTurnId = null;')).toContain('blockedResumeThreadId = null;');
    });
});
