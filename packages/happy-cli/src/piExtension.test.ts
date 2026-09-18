import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startDaemonControlServer } from './daemon/controlServer';
import extension from './piExtension';

const observed = vi.hoisted(() => ({ transports: [] as any[] }));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', async (original) => {
    const actual = await original<typeof import('@modelcontextprotocol/sdk/client/stdio.js')>();
    return { ...actual, StdioClientTransport: class extends actual.StdioClientTransport {
        constructor(args: any) { super(args); observed.transports.push(this); }
    } };
});

function piHarness() {
    const handlers: Record<string, any> = {};
    const tools = new Map<string, any>();
    extension({ on: (name, handler) => { handlers[name] = handler; }, registerTool: tool => tools.set(tool.name, tool) });
    return { handlers, tools };
}

describe('auto-discovered native Pi tools', () => {
    beforeEach(() => {
        vi.stubEnv('HAPPY_MCP_URL', '');
        vi.stubEnv('HAPPY_TERMINAL_MCP_URL', '');
        vi.stubEnv('VH_TERMINAL_ID', 'term_native');
        observed.transports.length = 0;
    });
    afterEach(() => { vi.unstubAllEnvs(); });

    it('stays inert outside a terminal and lets managed/temporary bridges own tools', () => {
        for (const id of ['', 'bad id']) {
            vi.stubEnv('VH_TERMINAL_ID', id);
            expect(piHarness().handlers).toEqual({});
        }
        vi.stubEnv('VH_TERMINAL_ID', 'term_native');
        for (const endpoint of ['HAPPY_MCP_URL', 'HAPPY_TERMINAL_MCP_URL']) {
            vi.stubEnv(endpoint, 'http://127.0.0.1:1234/managed');
            expect(piHarness().handlers).toEqual({});
            vi.stubEnv(endpoint, '');
        }
        expect(observed.transports).toHaveLength(0);
    });

    it('loads the compiled stdio tool surface on session start, calls the terminal daemon and closes on reload', async () => {
        const base = join(homedir(), 'code/github/skills/tmp/pi-terminal-session-tools/tests');
        await mkdir(base, { recursive: true });
        const home = await mkdtemp(join(base, 'native-'));
        const clipboard = vi.fn((text: string) => ({ delivered: true, truncated: false, totalBytes: Buffer.byteLength(text) }));
        const preview = vi.fn(() => ({ delivered: true }));
        const title = vi.fn(() => true);
        const token = 'local-test-control-token-never-a-real-credential';
        const daemon = await startDaemonControlServer({
            controlToken: token, getChildren: () => [], stopSession: () => false,
            spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }),
            requestShutdown: () => {}, onHappySessionWebhook: () => {},
            pushClipboard: clipboard, pushFilePreview: preview, setTerminalTitle: title,
        });
        await writeFile(join(home, 'daemon.state.json'), JSON.stringify({ pid: process.pid, httpPort: daemon.port, controlToken: token }));
        vi.stubEnv('VH_HAPPY_HOME_DIR', home);
        vi.stubEnv('HAPPY_HOME_DIR', join(home, 'wrong-daemon'));
        vi.stubEnv('HAPPY_PERMISSION_MODE', 'plan');
        vi.stubEnv('HAPPY_SESSION_VARIANT', 'assistant');
        let runtime = piHarness();
        expect(observed.transports).toHaveLength(0); // Factory starts no background resources.
        try {
            await runtime.handlers.session_start({}, { cwd: home });
            expect([...runtime.tools.keys()]).toEqual(['copy_to_clipboard', 'open_preview', 'change_title']);
            expect(Object.keys(runtime.handlers)).toEqual(['session_start', 'session_shutdown']);
            expect(process.env.HAPPY_HOME_DIR).toBe(join(home, 'wrong-daemon'));
            await runtime.tools.get('copy_to_clipboard').execute('1', { text: 'native pi' });
            expect(clipboard).toHaveBeenCalledWith('native pi', 'term_native');
            await runtime.tools.get('open_preview').execute('2', { path: 'notes.md' });
            expect(preview).toHaveBeenCalledWith('term_native', join(home, 'notes.md'), 'file');
            await runtime.tools.get('change_title').execute('3', { title: 'My terminal' });
            expect(title).toHaveBeenCalledWith('term_native', 'My terminal', false);
            await expect(runtime.tools.get('open_preview').execute('4', { path: '~/.ssh/id_ed25519' })).rejects.toThrow();

            // Each call rereads daemon state, so daemon replacement needs no Pi restart.
            await rm(join(home, 'daemon.state.json'));
            await expect(runtime.tools.get('copy_to_clipboard').execute('5', { text: 'offline' })).rejects.toThrow('Failed to push to clipboard');
            await writeFile(join(home, 'daemon.state.json'), JSON.stringify({ pid: process.pid, httpPort: daemon.port, controlToken: token }));
            expect((await runtime.tools.get('copy_to_clipboard').execute('6', { text: 'back' })).details.isError).toBe(false);

            const firstPid = observed.transports[0].pid;
            await runtime.handlers.session_shutdown({ reason: 'reload' }, {});
            expect(() => process.kill(firstPid, 0)).toThrow();
            await expect(runtime.tools.get('change_title').execute('7', { title: 'stale' })).rejects.toThrow('shut down');
            runtime = piHarness(); // Pi recreates extensions during /reload.
            await runtime.handlers.session_start({ reason: 'reload' }, { cwd: home });
            expect(runtime.tools.size).toBe(3);
            expect(observed.transports[1].pid).not.toBe(firstPid);
            await runtime.handlers.session_shutdown({}, {});
            await runtime.handlers.session_shutdown({}, {});
        } finally {
            await runtime.handlers.session_shutdown({}, {});
            await daemon.stop();
            await rm(home, { recursive: true, force: true });
        }
    }, 30_000);
});
