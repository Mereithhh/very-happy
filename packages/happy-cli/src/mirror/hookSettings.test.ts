import { describe, it, expect } from 'vitest';
import { applyTerminalHooks, removeTerminalHooks, hasTerminalHooks, HOOK_TIMEOUT_SECONDS, TERMINAL_MIRROR_FORWARDER_BASENAME } from './hookSettings';
import { terminalMirrorHookCommand } from '@/commands/installTerminalHooks';

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

describe('B-137: hook 命令必须自带守卫与 timeout', () => {
    it('生成的命令带存在性守卫——脚本没了要静默跳过，不是每次会话都报错', () => {
        const cmd = terminalMirrorHookCommand();
        expect(cmd).toContain(TERMINAL_MIRROR_FORWARDER_BASENAME);
        expect(cmd).toMatch(/^\[ -f "/);
        expect(cmd).toContain('|| true');
    });

    it('写进 settings 的条目带 timeout——SessionStart 默认 600s，卡住会拖死会话启动', () => {
        const { settings } = applyTerminalHooks({}, terminalMirrorHookCommand());
        for (const event of ['SessionStart', 'SessionEnd']) {
            const entry = (settings.hooks as any)[event][0].hooks[0];
            expect(entry.timeout, event).toBe(HOOK_TIMEOUT_SECONDS);
        }
    });

    it('从旧的裸命令升级：无守卫的既有条目会被替换掉而不是留着', () => {
        const legacy = applyTerminalHooks({}, `node "/old/path/${TERMINAL_MIRROR_FORWARDER_BASENAME}"`).settings;
        const { settings, changed } = applyTerminalHooks(legacy, terminalMirrorHookCommand());
        expect(changed).toBe(true);
        const entries = (settings.hooks as any).SessionStart;
        expect(entries).toHaveLength(1);
        expect(entries[0].hooks[0].command).toMatch(/^\[ -f "/);
        expect(entries[0].hooks[0].timeout).toBe(HOOK_TIMEOUT_SECONDS);
    });
});
