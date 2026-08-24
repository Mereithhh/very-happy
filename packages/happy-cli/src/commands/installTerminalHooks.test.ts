import { describe, expect, it } from 'vitest';
import { parseTerminalHooksArgs, TERMINAL_HOOKS_HELP } from './installTerminalHooks';

describe('install-terminal-hooks command parsing', () => {
    it('keeps installation explicit and supports a scoped rollback', () => {
        expect(parseTerminalHooksArgs([])).toEqual({ action: 'install' });
        expect(parseTerminalHooksArgs(['--remove'])).toEqual({ action: 'remove' });
    });

    it('shows help without selecting a mutating action', () => {
        expect(parseTerminalHooksArgs(['--help'])).toEqual({ action: 'help' });
        expect(parseTerminalHooksArgs(['-h'])).toEqual({ action: 'help' });
        expect(TERMINAL_HOOKS_HELP).toContain('foreign hooks are preserved');
    });

    it('rejects options that could otherwise be mistaken for a dry run', () => {
        expect(() => parseTerminalHooksArgs(['--dry-run'])).toThrow('Unknown install-terminal-hooks option');
    });
});
