import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { startDaemonControlServer } from '@/daemon/controlServer';
import { PI_TEAMS_EXTENSION } from '@/teams/resources';
import { readDaemonState } from '@/persistence';
import { runPiTerminal, startPiTerminalTools } from './piTerminal';

vi.mock('@/persistence', async (original) => ({
    ...await original<typeof import('@/persistence')>(),
    readDaemonState: vi.fn(),
}));

function extension() {
    return new Function('loadModule', PI_TEAMS_EXTENSION.replace('export default ', 'return ').replaceAll('import(', 'loadModule('))(
        (specifier: string) => import(specifier),
    );
}

describe('native pi terminal tools', () => {
    beforeEach(() => {
        vi.stubEnv('HAPPY_MCP_URL', '');
        vi.stubEnv('HAPPY_TERMINAL_MCP_URL', '');
        vi.stubEnv('VH_TERMINAL_ID', '');
    });
    afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

    it('loads all three tools and forwards their calls through authenticated daemon IPC without a native permission gate', async () => {
        const controlToken = 'test-runtime-control-token-with-at-least-256-bits-of-material';
        const clipboard = vi.fn((text: string) => ({ delivered: true, truncated: false, totalBytes: Buffer.byteLength(text) }));
        const preview = vi.fn(() => ({ delivered: true }));
        const title = vi.fn(() => true);
        const daemon = await startDaemonControlServer({
            controlToken, getChildren: () => [], stopSession: () => false,
            spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }),
            requestShutdown: () => {}, onHappySessionWebhook: () => {},
            pushClipboard: clipboard, pushFilePreview: preview, setTerminalTitle: title,
        });
        vi.mocked(readDaemonState).mockResolvedValue({ httpPort: daemon.port, pid: process.pid, controlToken } as any);
        const bridge = await startPiTerminalTools('term_1');
        vi.stubEnv('HAPPY_TERMINAL_MCP_URL', bridge.url);
        vi.stubEnv('HAPPY_PERMISSION_MODE', 'plan');
        const tools = new Map<string, any>();
        const on = vi.fn();
        try {
            await extension()({ on, registerTool: (tool: any) => tools.set(tool.name, tool) });
            expect([...tools.keys()]).toEqual(['copy_to_clipboard', 'open_preview', 'change_title']);
            expect(on).not.toHaveBeenCalled();

            const copied = await tools.get('copy_to_clipboard').execute('1', { text: 'copy me' });
            expect(copied.details.isError).toBe(false);
            expect(copied.content[0].text).toContain('does not confirm');
            expect(clipboard).toHaveBeenCalledWith('copy me', 'term_1');
            await tools.get('change_title').execute('2', { title: 'Pi task' });
            expect(title).toHaveBeenCalledWith('term_1', 'Pi task', false);
            await tools.get('open_preview').execute('3', { path: 'notes.md', mode: 'diff' });
            expect(preview).toHaveBeenCalledWith('term_1', resolve('notes.md'), 'diff');

            await expect(tools.get('open_preview').execute('4', { path: '~/.ssh/id_ed25519' })).rejects.toThrow();
            expect(preview).toHaveBeenCalledTimes(1);
            title.mockReturnValueOnce(false);
            await expect(tools.get('change_title').execute('5', { title: 'Cannot land' })).rejects.toThrow('Failed to change terminal title');

            vi.mocked(readDaemonState).mockResolvedValue(null);
            await expect(tools.get('copy_to_clipboard').execute('6', { text: 'offline' })).rejects.toThrow('Failed to push to clipboard');
        } finally { await bridge.stop(); await daemon.stop(); }
    });

    it('rejects browser requests and wrong capability paths before registering tools', async () => {
        const bridge = await startPiTerminalTools('term_1');
        try {
            expect((await fetch(bridge.url, { method: 'POST', headers: { origin: 'https://untrusted.test' } })).status).toBe(403);
            expect((await fetch(new URL('/wrong', bridge.url), { method: 'POST' })).status).toBe(403);
        } finally { await bridge.stop(); }
    });

    it('explains that native pi must be launched inside a Very Happy terminal', async () => {
        await expect(runPiTerminal([])).rejects.toThrow('inside a Very Happy terminal');
        vi.stubEnv('VH_TERMINAL_ID', 'bad id');
        await expect(runPiTerminal([])).rejects.toThrow('VH_TERMINAL_ID');
    });
});
