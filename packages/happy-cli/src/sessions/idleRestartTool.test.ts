import { describe, expect, it, vi } from 'vitest';
import { idleRestartToolResult, registerIdleRestartTool, IDLE_RESTART_TOOL_NAME, IDLE_RESTART_TOOL_DESCRIPTION } from './idleRestartTool';
import { claudeChildRunIntent } from '@/daemon/agentChildIntent';

describe('B-911 request_idle_restart', () => {
    it('takes no session id (it can only restart the caller) and states its limits', () => {
        const registerTool = vi.fn();
        registerIdleRestartTool({ registerTool } as never, async () => ({ text: 'x', isError: false }));
        expect(registerTool).toHaveBeenCalledWith(IDLE_RESTART_TOOL_NAME, expect.objectContaining({ inputSchema: {} }), expect.any(Function));
        expect(IDLE_RESTART_TOOL_DESCRIPTION).toMatch(/only restart this session/);
        expect(IDLE_RESTART_TOOL_DESCRIPTION).toMatch(/3 accepted requests per 24 hours/);
        expect(IDLE_RESTART_TOOL_DESCRIPTION).toMatch(/10 minutes/);
    });

    it('words every daemon answer for the model', () => {
        expect(idleRestartToolResult({ ok: true, state: 'queued', requestedAt: 1 })).toMatchObject({ isError: false, text: expect.stringMatching(/^Queued/) });
        expect(idleRestartToolResult({ ok: true, state: 'already-queued', requestedAt: 1 }).text).toMatch(/^Already queued/);
        expect(idleRestartToolResult({ ok: false, code: 'rate-limited', retryAfterMs: 125_000 })).toEqual({ isError: true, text: expect.stringMatching(/^Restart refused \(rate-limited\).*about 3 min/) });
        expect(idleRestartToolResult({ ok: false, code: 'cooldown', retryAfterMs: 1 }).text).toMatch(/about 1 min/);
        expect(idleRestartToolResult({ ok: false, code: 'daemon-too-old' }).text).toMatch(/predates this tool/);
        expect(idleRestartToolResult({ ok: false, code: 'whatever' }).text).toMatch(/^Restart refused \(whatever\)/);
    });

    it('a failing daemon call becomes a tool error, never a throw', async () => {
        let handler: (() => Promise<{ isError: boolean; content: { text: string }[] }>) | null = null;
        registerIdleRestartTool({ registerTool: (_n: string, _c: unknown, cb: typeof handler) => { handler = cb; } } as never, async () => { throw new Error('ECONNREFUSED'); });
        const result = await handler!();
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/ECONNREFUSED/);
    });
});

describe('B-911 old wrapper run intent from its Claude child', () => {
    it('reads the stream-json child of this wrapper only', async () => {
        const list = async () => [
            { pid: 10, ppid: 1, cmd: 'claude --output-format stream-json --model=other' },
            { pid: 11, ppid: 22378, cmd: 'node mcp-server.js --model=not-me' },
            { pid: 12, ppid: 22378, cmd: 'claude --output-format stream-json --effort=xhigh --model=claude-opus-5-5' },
        ];
        expect(await claudeChildRunIntent(22378, { list, readArgv: () => null })).toEqual({ model: 'claude-opus-5-5', effort: 'xhigh' });
        expect(await claudeChildRunIntent(22378, { list, readArgv: (pid) => pid === 12 ? ['claude', '--output-format', 'stream-json', '--model', 'opus[1m]'] : null })).toEqual({ model: 'opus[1m]' });
        expect(await claudeChildRunIntent(5, { list })).toEqual({});
        expect(await claudeChildRunIntent(5, { list: async () => { throw new Error('ps'); } })).toEqual({});
    });
});
