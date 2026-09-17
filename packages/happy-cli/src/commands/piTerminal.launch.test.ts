import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { preparePiTeamsRuntime } from '@/teams/piRuntime';
import { runPiTerminal } from './piTerminal';

vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: vi.fn() }));
vi.mock('@/teams/piRuntime', () => ({ preparePiTeamsRuntime: vi.fn(async () => ({
    PI_ACP_PI_COMMAND: '/isolated/official-pi-wrapper', VH_TEAM_PI_COMMAND: '/custom/user-pi',
})) }));

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('native pi launcher', () => {
    it('preserves Pi arguments and the configured delegate, then closes its local bridge when Pi exits', async () => {
        vi.stubEnv('VH_TERMINAL_ID', 'term_1');
        vi.stubEnv('HAPPY_MCP_URL', '');
        const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
        let bridgeUrl = '';
        vi.mocked(spawn).mockImplementation((command, args, options: any) => {
            expect(command).toBe('/isolated/official-pi-wrapper');
            expect(args).toEqual(['--model', 'test-model', 'task with spaces']);
            expect(options.env.VH_TEAM_PI_COMMAND).toBe('/custom/user-pi');
            expect(options.stdio).toBe('inherit');
            bridgeUrl = options.env.HAPPY_TERMINAL_MCP_URL;
            queueMicrotask(() => child.emit('exit', 7, null));
            return child as any;
        });
        expect(await runPiTerminal(['--model', 'test-model', 'task with spaces'])).toBe(7);
        expect(preparePiTeamsRuntime).toHaveBeenCalledOnce();
        expect(bridgeUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/terminal-tools\//);
        await expect(fetch(bridgeUrl)).rejects.toThrow();
    });

    it('keeps a managed MCP endpoint authoritative when inherited by native pi', async () => {
        vi.stubEnv('VH_TERMINAL_ID', 'term_1');
        vi.stubEnv('HAPPY_MCP_URL', 'http://127.0.0.1:54321/managed');
        vi.stubEnv('HAPPY_TERMINAL_MCP_URL', '');
        const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
        vi.mocked(spawn).mockImplementation((_command, _args, options: any) => {
            expect(options.env.HAPPY_MCP_URL).toBe('http://127.0.0.1:54321/managed');
            expect(options.env.HAPPY_TERMINAL_MCP_URL).toBe('');
            queueMicrotask(() => child.emit('exit', 0, null));
            return child as any;
        });
        expect(await runPiTerminal([])).toBe(0);
    });
});
