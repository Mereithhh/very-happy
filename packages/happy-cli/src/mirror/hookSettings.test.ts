import { describe, it, expect } from 'vitest';
import { applyTerminalHooks, removeTerminalHooks, hasTerminalHooks } from './hookSettings';

const CMD = 'node "/opt/vh/scripts/terminal_mirror_forwarder.cjs"';

describe('applyTerminalHooks', () => {
    it('installs SessionStart + SessionEnd as a pair into empty settings', () => {
        const { settings, changed } = applyTerminalHooks({}, CMD);
        expect(changed).toBe(true);
        expect(hasTerminalHooks(settings)).toBe(true);
        for (const event of ['SessionStart', 'SessionEnd']) {
            const entries = (settings.hooks as any)[event];
            expect(entries).toHaveLength(1);
            expect(entries[0].matcher).toBe('*');
            expect(entries[0].hooks[0].command).toBe(CMD);
        }
    });

    it('preserves foreign hooks and other settings keys', () => {
        const input = {
            model: 'opus',
            hooks: {
                SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'other-tool.sh' }] }],
                PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
            },
        };
        const { settings } = applyTerminalHooks(input, CMD);
        expect(settings.model).toBe('opus');
        expect((settings.hooks as any).PreToolUse).toEqual(input.hooks.PreToolUse);
        const starts = (settings.hooks as any).SessionStart;
        expect(starts).toHaveLength(2);
        expect(starts[0].hooks[0].command).toBe('other-tool.sh');
        // Input not mutated
        expect(input.hooks.SessionStart).toHaveLength(1);
    });

    it('is idempotent and reports changed=false on a re-run', () => {
        const first = applyTerminalHooks({}, CMD);
        const second = applyTerminalHooks(first.settings, CMD);
        expect(second.changed).toBe(false);
        expect(second.settings).toEqual(first.settings);
    });

    it('replaces a stale-path entry of ours instead of duplicating', () => {
        const stale = applyTerminalHooks({}, 'node "/old/path/terminal_mirror_forwarder.cjs"').settings;
        const { settings, changed } = applyTerminalHooks(stale, CMD);
        expect(changed).toBe(true);
        const starts = (settings.hooks as any).SessionStart;
        expect(starts).toHaveLength(1);
        expect(starts[0].hooks[0].command).toBe(CMD);
    });
});

describe('removeTerminalHooks', () => {
    it('removes only our entries and drops empty containers', () => {
        const installed = applyTerminalHooks({ model: 'opus' }, CMD).settings;
        const { settings, changed } = removeTerminalHooks(installed);
        expect(changed).toBe(true);
        expect(settings.hooks).toBeUndefined();
        expect(settings.model).toBe('opus');
        expect(hasTerminalHooks(settings)).toBe(false);
    });

    it('keeps foreign hooks intact', () => {
        const base = applyTerminalHooks({
            hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'other.sh' }] }] },
        }, CMD).settings;
        const { settings } = removeTerminalHooks(base);
        expect((settings.hooks as any).SessionStart).toHaveLength(1);
        expect((settings.hooks as any).SessionStart[0].hooks[0].command).toBe('other.sh');
        expect((settings.hooks as any).SessionEnd).toBeUndefined();
    });

    it('no-ops on settings without our hooks', () => {
        expect(removeTerminalHooks({ model: 'opus' }).changed).toBe(false);
        expect(removeTerminalHooks(null).changed).toBe(false);
    });
});
