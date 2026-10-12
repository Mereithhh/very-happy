/**
 * B-562: `open_preview(download: true)` end to end over the real http MCP
 * (StreamableHTTP client → startHappyServer → ApiSessionClient.pushFilePreview).
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ApiSessionClient } from '@/api/apiSession';
import { startHappyServer } from './startHappyServer';

describe('B-562 open_preview download over the http MCP', () => {
    const pushFilePreview = vi.fn((_path: string, _mode: string, _intent?: string) => ({ delivered: true }));
    let dir: string;
    let server: Awaited<ReturnType<typeof startHappyServer>>;
    let client: Client;

    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'vh-open-preview-'));
        await writeFile(join(dir, 'out.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
        await mkdir(join(dir, 'folder'));
        const session = {
            sessionId: 'download-test',
            rpcHandlerManager: { registerHandler: vi.fn(), unregisterHandler: vi.fn() },
            updateMetadata: vi.fn(),
            pushFilePreview,
        } as unknown as ApiSessionClient;
        server = await startHappyServer(session);
        client = new Client({ name: 'b562-test', version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    });
    afterAll(async () => {
        await client.close();
        server.stop();
        await rm(dir, { recursive: true, force: true });
    });

    const call = async (args: Record<string, unknown>) => {
        const res = await client.callTool({ name: 'open_preview', arguments: args });
        const text = (res.content as Array<{ text: string }>)[0].text;
        return { isError: res.isError === true, text };
    };

    it('advertises the optional download flag', async () => {
        const { tools } = await client.listTools();
        const preview = tools.find(t => t.name === 'open_preview')!;
        expect(preview.inputSchema.properties).toHaveProperty('download');
        expect(preview.inputSchema.required ?? []).not.toContain('download');
    });

    it('pushes the download intent only when asked', async () => {
        pushFilePreview.mockClear();
        const file = join(dir, 'out.zip');
        const plain = await call({ path: file });
        expect(plain.isError).toBe(false);
        expect(pushFilePreview).toHaveBeenLastCalledWith(file, 'file', undefined);
        const download = await call({ path: file, download: true });
        expect(download.isError).toBe(false);
        expect(download.text).toContain('for download');
        expect(pushFilePreview).toHaveBeenLastCalledWith(file, 'file', 'download');
    });

    it('refuses directories and missing files without pushing; plain previews stay unchecked', async () => {
        pushFilePreview.mockClear();
        const folder = await call({ path: join(dir, 'folder'), download: true });
        expect(folder.isError).toBe(true);
        expect(folder.text).toContain('zip -r');
        const missing = await call({ path: join(dir, 'gone.zip'), download: true });
        expect(missing.isError).toBe(true);
        expect(pushFilePreview).not.toHaveBeenCalled();
        // B-131 behaviour unchanged: a plain preview of a missing path is still pushed.
        expect((await call({ path: join(dir, 'gone.zip') })).isError).toBe(false);
        expect(pushFilePreview).toHaveBeenCalledTimes(1);
    });

    it('keeps the credential path gate in front of downloads', async () => {
        pushFilePreview.mockClear();
        const denied = await call({ path: '~/.ssh/id_ed25519', download: true });
        expect(denied.isError).toBe(true);
        expect(denied.text).toContain('refusing');
        expect(pushFilePreview).not.toHaveBeenCalled();
    });
});
