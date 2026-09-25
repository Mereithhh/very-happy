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
    it('surfaces a launch failure instead of hanging', async () => {
        const result = await runScript({ command: ['/definitely/not/a/binary'], timeoutMs: 2_000 });
        expect(result.error).toBeTruthy();
        expect(result.exitCode).toBeNull();
    });
});
