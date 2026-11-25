import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { parseCodexModelWindowsOutput, readCodexModelWindows } from './codexModelWindows';

const dump = JSON.stringify({ models: [
    { slug: 'gpt-6.2-sol', context_window: 500000, max_context_window: 872000, effective_context_window_percent: 95 },
    { slug: 'gpt-5.5', context_window: 272000, max_context_window: 272000, effective_context_window_percent: 95 },
    { slug: 'broken' },
] });

function fakeSpawn(stdout: string, code = 0) {
    return vi.fn(() => {
        const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => void };
        child.stdout = new PassThrough();
        child.kill = vi.fn();
        setTimeout(() => { child.stdout.write(stdout); child.stdout.end(); child.emit('close', code); }, 0);
        return child;
    });
}

describe('B-977 readCodexModelWindows', () => {
    it('parses `codex debug models` after a warning line', () => {
        const windows = parseCodexModelWindowsOutput(`WARNING: proceeding\n${dump}`);
        expect(windows.get('gpt-6.2-sol')).toEqual({ window: 500000, maxWindow: 872000, effectivePercent: 95 });
        expect(windows.get('gpt-5.5')).toEqual({ window: 272000, maxWindow: 272000, effectivePercent: 95 });
        expect(windows.has('broken')).toBe(false);
        expect(parseCodexModelWindowsOutput('no json').size).toBe(0);
        expect(parseCodexModelWindowsOutput('{oops').size).toBe(0);
    });

    it('runs codex with the app-server env and provider args', async () => {
        const spawn = fakeSpawn(dump);
        const windows = await readCodexModelWindows({ env: { CODEX_HOME: '/overlay' }, args: ['-c', 'model_provider="x"'], spawn: spawn as never });
        expect(spawn).toHaveBeenCalledWith('codex', ['-c', 'model_provider="x"', 'debug', 'models'], expect.objectContaining({ env: { CODEX_HOME: '/overlay' } }));
        expect(windows.size).toBe(2);
    });

    it('a failing command gives an empty catalog, never an error', async () => {
        await expect(readCodexModelWindows({ env: {}, spawn: fakeSpawn(dump, 1) as never })).resolves.toEqual(new Map());
        const throwing = vi.fn(() => { throw new Error('ENOENT'); });
        await expect(readCodexModelWindows({ env: {}, spawn: throwing as never })).resolves.toEqual(new Map());
    });
});
