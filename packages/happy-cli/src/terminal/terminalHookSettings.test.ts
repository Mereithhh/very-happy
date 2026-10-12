import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'vh-term-hooks-'));
vi.mock('@/configuration', () => ({ configuration: { happyHomeDir: home } }));
vi.mock('@/ui/logger', () => ({ logger: { debug: () => undefined } }));

const { ClaudeVersionCache, removeTerminalHookSettings, sweepStaleTerminalHookSettings, terminalHookSettingsPath, withTerminalHooks } = await import('./terminalHookSettings');

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('withTerminalHooks (B-547)', () => {
    it('writes the per-terminal settings file and injects --settings', () => {
        const out = withTerminalHooks('claude --resume 0b5c7c0e-1111-2222-3333-444455556666', 'term1', '2.1.296');
        const path = terminalHookSettingsPath('term1');
        expect(path.startsWith(join(home, 'tmp', 'terminal-hooks'))).toBe(true);
        expect(out).toBe(`claude --settings '${path}' --resume 0b5c7c0e-1111-2222-3333-444455556666`);
        const settings = JSON.parse(readFileSync(path, 'utf-8'));
        expect(Object.keys(settings.hooks)).toContain('UserPromptSubmit');
        const command: string = settings.hooks.Stop[0].hooks[0].command;
        expect(command).toContain('terminal_status_forwarder.cjs');
        expect(command).toContain(`'term1' '${home}' "$PPID"`);
        removeTerminalHookSettings('term1');
        expect(existsSync(path)).toBe(false);
    });

    it('changes nothing when the version is unknown/old or the command is not a bare claude', () => {
        expect(withTerminalHooks('claude', 'term2', null)).toBe('claude');
        expect(withTerminalHooks('claude', 'term2', '1.0.80')).toBe('claude');
        expect(withTerminalHooks('pi', 'term2', '2.1.296')).toBe('pi');
        expect(existsSync(terminalHookSettingsPath('term2'))).toBe(false);
    });
});

describe('ClaudeVersionCache (B-547)', () => {
    it('never probes before start(); then serves the probed version', async () => {
        const probe = vi.fn(async () => '2.1.296');
        const cache = new ClaudeVersionCache(() => ({}), probe);
        expect(cache.current()).toBeNull();
        expect(probe).not.toHaveBeenCalled();
        cache.start();
        expect(await cache.settled(1000)).toBe('2.1.296');
        expect(probe).toHaveBeenCalledTimes(1);
        expect(cache.current()).toBe('2.1.296');
        expect(probe).toHaveBeenCalledTimes(1);
    });

    it('a failed probe keeps the last good answer; settled() is bounded', async () => {
        let answer: string | null = '2.0.50';
        const cache = new ClaudeVersionCache(() => ({}), async () => answer);
        cache.start(0);
        expect(await cache.settled(1000)).toBe('2.0.50');
        answer = null;
        cache.current(Date.now() + 7 * 60 * 60_000);
        expect(await cache.settled(1000)).toBe('2.0.50');

        const hung = new ClaudeVersionCache(() => ({}), () => new Promise(() => undefined));
        hung.start();
        const t = Date.now();
        expect(await hung.settled(50)).toBeNull();
        expect(Date.now() - t).toBeLessThan(1000);
    });
});

describe('sweepStaleTerminalHookSettings (B-547)', () => {
    it('removes only files of terminals that are not live', () => {
        withTerminalHooks('claude', 'live1', '2.1.296');
        withTerminalHooks('claude', 'dead1', '2.1.296');
        const removed = sweepStaleTerminalHookSettings((id) => id === 'live1');
        expect(removed).toEqual(['dead1']);
        expect(existsSync(terminalHookSettingsPath('live1'))).toBe(true);
        expect(existsSync(terminalHookSettingsPath('dead1'))).toBe(false);
        removeTerminalHookSettings('live1');
    });

    it('is a no-op without the directory', () => {
        rmSync(join(home, 'tmp'), { recursive: true, force: true });
        expect(sweepStaleTerminalHookSettings(() => false)).toEqual([]);
    });
});
