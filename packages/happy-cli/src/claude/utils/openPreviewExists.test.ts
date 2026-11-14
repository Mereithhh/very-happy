/**
 * B-938: open_preview used to push any path that passed the credential denylist, so a model
 * that never generated its report still got "delivered" and told the user "the preview is
 * open". Every entry now stats the resolved path first:
 *  - Claude / managed pi / Gemini: in-process http MCP (startHappyServer);
 *  - Codex: the stdio bridge, which forwards to that same http MCP (spawned for real here);
 *  - native pi / terminal agents: `very-happy mcp --terminal-tools` (registerMcpTools).
 */
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AssistantToolRegistrar } from '@/assistant/assistantTools';
import { startHappyServer } from './startHappyServer';

const daemonPreview = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ delivered: true })));
vi.mock('@/daemon/controlClient', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/daemon/controlClient')>()),
    pushFilePreviewViaDaemon: daemonPreview,
}));

const textOf = (res: unknown) => ((res as { content: Array<{ text: string }> }).content)[0].text;

let dir: string;
beforeAll(async () => {
    // realpath: macOS tmpdir is a symlink; resolve() would not follow it.
    dir = await realpath(await mkdtemp(join(tmpdir(), 'vh-b938-')));
    await writeFile(join(dir, 'report.html'), '<p>ok</p>');
    await mkdir(join(dir, 'site'));
    await mkdir(join(dir, 'other'));
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe('B-938 open_preview over the in-process http MCP (Claude / Codex)', () => {
    const pushFilePreview = vi.fn((_path: string, _mode: string, _intent?: string) => ({ delivered: true }));
    let server: Awaited<ReturnType<typeof startHappyServer>>;
    let client: Client;
    let sessionCwd: string;

    beforeAll(async () => {
        sessionCwd = join(dir, 'other');
        const session = {
            sessionId: 'b938-test',
            rpcHandlerManager: { registerHandler: vi.fn(), unregisterHandler: vi.fn() },
            updateMetadata: vi.fn(),
            // The session's working directory deliberately differs from process.cwd().
            getMetadata: () => ({ path: sessionCwd }),
            pushFilePreview,
        } as unknown as ApiSessionClient;
        server = await startHappyServer(session);
        client = new Client({ name: 'b938-test', version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    });
    afterAll(async () => {
        await client.close();
        server.stop();
    });

    const call = async (args: Record<string, unknown>) => {
        const res = await client.callTool({ name: 'open_preview', arguments: args });
        return { isError: res.isError === true, text: textOf(res) };
    };

    it('refuses a file that was never generated, and tells the model not to claim it is open', async () => {
        pushFilePreview.mockClear();
        const missing = await call({ path: join(dir, 'never-written.html') });
        expect(missing.isError).toBe(true);
        expect(missing.text).toContain('does not exist');
        expect(missing.text).toContain('do not tell them the preview is open');
        expect(pushFilePreview).not.toHaveBeenCalled();
    });

    it('refuses a directory', async () => {
        pushFilePreview.mockClear();
        const folder = await call({ path: join(dir, 'site') });
        expect(folder.isError).toBe(true);
        expect(folder.text).toContain('is a directory');
        expect(pushFilePreview).not.toHaveBeenCalled();
    });

    it('still pushes an existing file', async () => {
        pushFilePreview.mockClear();
        const ok = await call({ path: join(dir, 'report.html') });
        expect(ok.isError).toBe(false);
        expect(pushFilePreview).toHaveBeenCalledWith(join(dir, 'report.html'), 'file', undefined);
    });

    it('resolves a relative path against the session working directory, not process.cwd()', async () => {
        expect(process.cwd()).not.toBe(sessionCwd);
        pushFilePreview.mockClear();
        const ok = await call({ path: '../report.html' });
        expect(ok.isError).toBe(false);
        expect(pushFilePreview).toHaveBeenCalledWith(join(dir, 'report.html'), 'file', undefined);
    });

    it('keeps the credential denylist in front (denied before any stat)', async () => {
        pushFilePreview.mockClear();
        const denied = await call({ path: '~/.ssh/id_ed25519' });
        expect(denied.isError).toBe(true);
        expect(denied.text).toContain('refusing');
        expect(pushFilePreview).not.toHaveBeenCalled();
    });

    it('Codex: the stdio bridge returns the same refusal (spawned against this http MCP)', async () => {
        pushFilePreview.mockClear();
        const bridge = new Client({ name: 'b938-codex', version: '1.0.0' });
        const pkg = resolve(__dirname, '../../..');
        await bridge.connect(new StdioClientTransport({
            command: process.execPath,
            args: ['--import', 'tsx', resolve(pkg, 'src/codex/happyMcpStdioBridge.ts'), '--url', server.url],
            cwd: pkg,
            stderr: 'ignore',
        }));
        try {
            const res = await bridge.callTool({ name: 'open_preview', arguments: { path: join(dir, 'never-written.html') } });
            expect(res.isError).toBe(true);
            expect(textOf(res)).toContain('does not exist');
            expect(pushFilePreview).not.toHaveBeenCalled();
        } finally {
            await bridge.close();
        }
    }, 30_000);
});

describe('B-938 open_preview in `very-happy mcp --terminal-tools` (native pi / terminal agents)', () => {
    type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    const handlers = new Map<string, Handler>();
    const server = {
        registerTool: ((name: string, _config: unknown, handler: Handler) => { handlers.set(name, handler); return {} as never; }) as unknown as AssistantToolRegistrar['registerTool'],
    };
    beforeAll(async () => {
        const { registerMcpTools } = await import('@/commands/mcp');
        registerMcpTools(server, 'clipboard', 'term_1');
    });

    it('refuses missing files and directories without asking the daemon; pushes real files', async () => {
        const preview = handlers.get('open_preview')!;
        daemonPreview.mockClear();
        const missing = await preview({ path: join(dir, 'never-written.html') });
        expect(missing.isError).toBe(true);
        expect(missing.content[0].text).toContain('does not exist');
        const folder = await preview({ path: join(dir, 'site') });
        expect(folder.isError).toBe(true);
        expect(folder.content[0].text).toContain('is a directory');
        expect(daemonPreview).not.toHaveBeenCalled();
        const ok = await preview({ path: join(dir, 'report.html') });
        expect(ok.isError).toBe(false);
        expect(daemonPreview).toHaveBeenCalledWith('term_1', join(dir, 'report.html'), 'file', undefined);
    });
});
