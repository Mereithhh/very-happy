import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appendPrecheckOutput, defaultPrecheckCwd, evaluatePrecheck, precheckTimeoutMs, runPrecheck } from './precheck';

const posix = process.platform !== 'win32';
const base = { exitCode: 0, signal: null, timedOut: false, stdout: '', output: '', durationMs: 1 };

describe('B-548 precheck verdicts', () => {
    it('passes only a clean exit 0 and maps everything else to a reason code', () => {
        expect(evaluatePrecheck({ ...base, stdout: 'x' }, 60_000)).toEqual({ pass: true, stdout: 'x' });
        expect(evaluatePrecheck({ ...base, exitCode: 2, output: 'nope\n' }, 60_000)).toEqual({ pass: false, reason: 'precheck_failed', attention: false, summary: 'Precheck exited 2; nothing to do.\nnope', exitCode: 2 });
        expect(evaluatePrecheck({ ...base, exitCode: 0, timedOut: true }, 60_000)).toMatchObject({ pass: false, reason: 'precheck_timeout', attention: true, summary: 'Precheck timed out after 60s; the action was not run.' });
        expect(evaluatePrecheck({ ...base, exitCode: null, error: 'spawn x ENOENT' }, 60_000)).toMatchObject({ pass: false, reason: 'precheck_error', attention: true });
    });
    it('clamps the timeout and picks the action directory by default', () => {
        expect(precheckTimeoutMs({})).toBe(60_000);
        expect(precheckTimeoutMs({ timeoutMs: 10_000_000 })).toBe(600_000);
        expect(defaultPrecheckCwd({ kind: 'spawn', agent: 'claude', directory: '/repo', prompt: 'p' })).toBe('/repo');
        expect(defaultPrecheckCwd({ kind: 'script', command: ['x'] })).toBeUndefined();
        expect(defaultPrecheckCwd({ kind: 'send', sessionId: 's', prompt: 'p' })).toBeUndefined();
    });
    it('appends trimmed stdout as context, or leaves the prompt alone', () => {
        expect(appendPrecheckOutput('Do it', '  2 new\n')).toBe('Do it\n\n[precheck output]\n2 new');
        expect(appendPrecheckOutput('Do it', ' \n')).toBe('Do it');
    });
});

describe.skipIf(!posix)('B-548 precheck process', () => {
    const root = join(homedir(), 'code/github/skills/tmp/vh-automation/tests');
    mkdirSync(root, { recursive: true });

    it('runs argv without a shell and a shell line with one, in cwd, with env', async () => {
        const cwd = mkdtempSync(join(root, 'precheck-'));
        try {
            const argv = await runPrecheck({ command: ['/bin/sh', '-c', 'echo "$VH_X in $(pwd)"; echo err >&2; exit 0'], cwd, timeoutMs: 10_000, env: { VH_X: 'hi' } });
            expect(argv).toMatchObject({ exitCode: 0, timedOut: false });
            expect(argv.stdout.trim()).toMatch(/^hi in .*precheck-/);
            expect(argv.output).toContain('err');
            expect(argv.stdout).not.toContain('err');
            const shell = await runPrecheck({ shell: 'test -n "$VH_X" && exit 7', cwd, timeoutMs: 10_000, env: { VH_X: '1' } });
            expect(shell.exitCode).toBe(7);
            const missing = await runPrecheck({ command: ['/definitely/not/here'], cwd, timeoutMs: 10_000 });
            expect(missing.error).toMatch(/ENOENT/);
        } finally { rmSync(cwd, { recursive: true, force: true }); }
    });

    it('keeps only the last 4000 characters of output', async () => {
        const r = await runPrecheck({ shell: 'head -c 10000 /dev/zero | tr "\\0" a; printf END', cwd: root, timeoutMs: 10_000 });
        expect(r.stdout.length).toBe(4000);
        expect(r.stdout.endsWith('END')).toBe(true);
    });

    it('on timeout kills the whole process group, grandchildren included', async () => {
        const started = Date.now();
        const r = await runPrecheck({ shell: 'sleep 30 & echo $!; wait', cwd: root, timeoutMs: 1_000 });
        expect(r.timedOut).toBe(true);
        expect(Date.now() - started).toBeLessThan(10_000);
        const grandchild = Number(r.stdout.trim());
        expect(grandchild).toBeGreaterThan(0);
        let alive = true;
        for (let i = 0; i < 50 && alive; i++) {
            try { process.kill(grandchild, 0); await new Promise((resolve) => setTimeout(resolve, 100)); } catch { alive = false; }
        }
        expect(alive).toBe(false);
    }, 20_000);
});
