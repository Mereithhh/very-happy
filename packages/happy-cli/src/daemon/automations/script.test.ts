import { describe, expect, it } from 'vitest';
import { runScript, TailBuffer } from './script';

const node = process.execPath;

describe('automation script runner', () => {
    it('runs argv without a shell, merges output and reports the exit code', async () => {
        const result = await runScript({ command: [node, '-e', 'process.stdout.write("out " + process.env.VH_AUTOMATION_PAYLOAD); process.stderr.write("err"); process.exit(3)'], env: { VH_AUTOMATION_PAYLOAD: '$HOME {{x}}' }, timeoutMs: 10_000 });
        expect(result.exitCode).toBe(3);
        expect(result.timedOut).toBe(false);
        expect(result.output).toContain('out $HOME {{x}}');
        expect(result.output).toContain('err');
    });
    it('keeps only the tail of long output', async () => {
        const result = await runScript({ command: [node, '-e', 'process.stdout.write("a".repeat(10000) + "END")'], timeoutMs: 10_000 });
        expect(result.exitCode).toBe(0);
        expect(result.output.length).toBe(4096);
        expect(result.output.endsWith('END')).toBe(true);
        const tail = new TailBuffer(3);
        for (const chunk of ['ab', 'cd', 'efg']) tail.push(chunk);
        expect(tail.value()).toBe('efg');
    });
    it('terminates on timeout (SIGTERM first) and flags it', async () => {
        const result = await runScript({ command: [node, '-e', 'setInterval(() => {}, 1000)'], timeoutMs: 300 });
        expect(result.timedOut).toBe(true);
        expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
    }, 15_000);
    it('kills the whole process group on timeout, including a grandchild holding stdout', async () => {
        const started = Date.now();
        // sh spawns a sleeping grandchild that inherits stdout; only a group kill ends the run promptly.
        const result = await runScript({ command: ['/bin/sh', '-c', 'sleep 30 & echo started; wait'], timeoutMs: 500 });
        expect(result.timedOut).toBe(true);
        expect(result.output).toContain('started');
        expect(Date.now() - started).toBeLessThan(10_000);
    }, 15_000);
    it('settles on exit after a bounded drain when a detached grandchild keeps the pipes open', async () => {
        const started = Date.now();
        const result = await runScript({ command: ['/bin/sh', '-c', '(sleep 30 &) ; echo parent-done; exit 7'], timeoutMs: 20_000 });
        expect(result.exitCode).toBe(7);
        expect(result.output).toContain('parent-done');
        expect(Date.now() - started).toBeLessThan(6_000);
    }, 15_000);
    it('surfaces a launch failure instead of hanging', async () => {
        const result = await runScript({ command: ['/definitely/not/a/binary'], timeoutMs: 2_000 });
        expect(result.error).toBeTruthy();
        expect(result.exitCode).toBeNull();
    });
});
