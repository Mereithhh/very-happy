/**
 * B-278: resolving the Claude binary for one-shot helpers (title, board
 * analyzer) must never exit the wrapper. The launcher util `getClaudeCliPath()`
 * calls process.exit(1) on a miss; a try/catch cannot stop that.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveClaudeBinary } from './titleGenerator';

describe('resolveClaudeBinary (B-278)', () => {
    const saved = { PATH: process.env.PATH, HOME: process.env.HOME, HAPPY_CLAUDE_PATH: process.env.HAPPY_CLAUDE_PATH };
    afterEach(() => {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        vi.restoreAllMocks();
    });

    it('with no Claude installed anywhere, falls back to PATH and never exits (real cjs util)', () => {
        const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`process.exit(${code})`); }) as never);
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const empty = mkdtempSync(join(tmpdir(), 'b278-'));
        process.env.PATH = empty; // no claude, no npm/bun to ask for a global root
        process.env.HOME = empty; // no native installer under ~/.local
        delete process.env.HAPPY_CLAUDE_PATH;
        expect(resolveClaudeBinary()).toBe('claude');
        expect(exit).not.toHaveBeenCalled();
    });

    it('uses the non-exiting finder and its path when one is found', () => {
        const getClaudeCliPath = vi.fn(() => { throw new Error('must not be called'); });
        expect(resolveClaudeBinary(() => ({ findGlobalClaudeCliPath: () => ({ path: '/opt/claude/bin/claude', source: 'npm' }), getClaudeCliPath } as never))).toBe('/opt/claude/bin/claude');
        expect(getClaudeCliPath).not.toHaveBeenCalled();
    });

    it('a miss falls back to HAPPY_CLAUDE_PATH, then plain `claude`', () => {
        const utils = () => ({ findGlobalClaudeCliPath: () => null });
        process.env.HAPPY_CLAUDE_PATH = '/custom/claude';
        expect(resolveClaudeBinary(utils)).toBe('/custom/claude');
        delete process.env.HAPPY_CLAUDE_PATH;
        expect(resolveClaudeBinary(utils)).toBe('claude');
    });
});
