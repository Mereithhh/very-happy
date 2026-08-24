import { describe, expect, it } from 'vitest';
import { parseTerminalHooksArgs, terminalHooksTmuxReadiness, TERMINAL_HOOKS_HELP } from './installTerminalHooks';

describe('install-terminal-hooks command parsing', () => {
    it('keeps installation explicit and supports a scoped rollback', () => {
        expect(parseTerminalHooksArgs([])).toEqual({ action: 'install' });
        expect(parseTerminalHooksArgs(['--remove'])).toEqual({ action: 'remove' });
    });

    it('shows help without selecting a mutating action', () => {
        expect(parseTerminalHooksArgs(['--help'])).toEqual({ action: 'help' });
        expect(parseTerminalHooksArgs(['-h'])).toEqual({ action: 'help' });
        expect(TERMINAL_HOOKS_HELP).toContain('foreign hooks are preserved');
        expect(TERMINAL_HOOKS_HELP).toContain('tmux 3.2 or newer');
        expect(TERMINAL_HOOKS_HELP).toContain('Installation stops before changing');
    });

    it('rejects options that could otherwise be mistaken for a dry run', () => {
        expect(() => parseTerminalHooksArgs(['--dry-run'])).toThrow('Unknown install-terminal-hooks option');
    });

    it('accepts only tmux versions that can carry the mirror environment markers', () => {
        expect(terminalHooksTmuxReadiness(0, 'tmux 3.2a\n')).toEqual({
            ready: true,
            version: 'tmux 3.2a',
        });
        expect(terminalHooksTmuxReadiness(0, 'tmux 3.1c\n')).toEqual({
            ready: false,
            version: 'tmux 3.1c',
            reason: 'too-old',
        });
        expect(terminalHooksTmuxReadiness(null, undefined)).toEqual({
            ready: false,
            reason: 'missing',
        });
    });
});
