import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginCliError, addPlugin, disablePlugin, enablePlugin, pluginEnv, readManifestSource, removePlugin, rotatePlugin, updatePlugin, type PluginServerApi } from './cli';
import { PluginServerClient, PluginServerError } from './serverOp';
import { manifestHash } from './manifest';
import { applyServerInstall, PluginStore } from './store';
import { sampleManifest, tempHome } from './testFixtures';

function mockServer(over: Partial<PluginServerApi> = {}): PluginServerApi & { submitManifest: ReturnType<typeof vi.fn> } {
    return {
        submitManifest: vi.fn(async () => ({ installId: 'pi_1', state: 'pending', reviewUrl: 'https://web.example.test/settings/plugins/pi_1/review' })),
        disable: vi.fn(async () => ({})),
        remove: vi.fn(async () => ({})),
        ...over,
    } as any;
}

describe('B-974c very-happy plugin (DESIGN §2.2, §3.3, §7)', () => {
    let cleanup = () => {};
    afterEach(() => cleanup());
    const text = (m = sampleManifest()) => ({ text: JSON.stringify(m), source: '/tmp/vh-plugin.json' });

    it('add: pending on the server, manifest kept as pending.json, no token or secret', async () => {
        const t = tempHome(); cleanup = t.cleanup;
        const store = new PluginStore(t.home);
        const server = mockServer();
        const r = await addPlugin(store, server, text());
        expect(r).toMatchObject({ id: 'hello-board', installId: 'pi_1', state: 'pending', reviewUrl: expect.stringContaining('/review') });
        expect(server.submitManifest).toHaveBeenCalledWith(expect.objectContaining({ id: 'hello-board' }));
        expect(store.readPending('hello-board')?.manifestHash).toBe(manifestHash(sampleManifest()));
        expect(store.readApprovedManifest('hello-board')).toBeNull();
        expect(existsSync(store.tokenFile('hello-board'))).toBe(false);
        expect(existsSync(store.secretFile('hello-board'))).toBe(false);
        expect(statSync(store.dir('hello-board')).mode & 0o777).toBe(0o700);
        expect(statSync(join(t.home, 'plugins')).mode & 0o777).toBe(0o700);
        await expect(addPlugin(store, server, text())).rejects.toMatchObject({ code: 'already_installed' });
    });

    it('add against an old server (404) → server_too_old and nothing written', async () => {
        const t = tempHome(); cleanup = t.cleanup;
        const store = new PluginStore(t.home);
        const server = mockServer({ submitManifest: async () => { throw new PluginServerError('server_too_old', 'old', 404); } });
        await expect(addPlugin(store, server, text())).rejects.toMatchObject({ code: 'server_too_old' });
        expect(existsSync(join(t.home, 'plugins'))).toBe(false);
    });

    it('add rejects invalid manifests before contacting the server', async () => {
        const t = tempHome(); cleanup = t.cleanup;
        const server = mockServer();
        await expect(addPlugin(new PluginStore(t.home), server, { text: JSON.stringify({ ...sampleManifest(), schema: 'vh-plugin/v9' }), source: 'x' })).rejects.toMatchObject({ code: 'unsupported_schema' });
        await expect(addPlugin(new PluginStore(t.home), server, { text: JSON.stringify({ ...sampleManifest(), panels: [{ id: 'main', title: 'x', upstream: 'http://10.0.0.1:80' }] }), source: 'x' })).rejects.toMatchObject({ code: 'invalid_manifest' });
        expect(server.submitManifest).not.toHaveBeenCalled();
    });

    it('update: privileged change waits for approval while the old approval keeps working; cosmetic change applies', async () => {
        const t = tempHome(); cleanup = t.cleanup;
        const store = new PluginStore(t.home);
        await addPlugin(store, mockServer(), text());
        applyServerInstall(store, 'hello-board', { installId: 'pi_1', state: 'enabled', grants: ['sidebar', 'panel'], manifestHash: manifestHash(sampleManifest()) });
        const token = store.readToken('hello-board');
        expect(token).toMatch(/^vhp_/);

        const widened = sampleManifest({ permissions: ['sidebar', 'panel', 'decisions', 'session.widget', 'sessions.read'] });
        const r = await updatePlugin(store, mockServer({ submitManifest: async () => ({ installId: 'pi_1', state: 'update_pending', manifestHash: manifestHash(widened) }) }), 'hello-board', text(widened));
        expect(r).toMatchObject({ needsApproval: true, privilegedChanged: true, state: 'update_pending' });
        expect(store.readApprovedManifest('hello-board')?.permissions).not.toContain('sessions.read');
        expect(store.readToken('hello-board')).toBe(token);
        expect(store.readInstall('hello-board')?.grants).toEqual(['sidebar', 'panel']);

        const cosmetic = sampleManifest({ version: '0.2.0' });
        const r2 = await updatePlugin(store, mockServer({ submitManifest: async () => ({ installId: 'pi_1', state: 'enabled', manifestHash: manifestHash(cosmetic), grants: ['sidebar', 'panel'] }) }), 'hello-board', text(cosmetic));
        expect(r2).toMatchObject({ needsApproval: false, privilegedChanged: false, state: 'enabled' });
        expect(store.readApprovedManifest('hello-board')?.version).toBe('0.2.0');
        expect(store.readPending('hello-board')).toBeNull();
        await expect(updatePlugin(store, mockServer(), 'hello-board', text(sampleManifest({ id: 'other-id' })))).rejects.toMatchObject({ code: 'invalid_manifest' });
    });

    it('disable is local first, enable clears it, remove deletes credentials, rotate replaces both', async () => {
        const t = tempHome(); cleanup = t.cleanup;
        const store = new PluginStore(t.home);
        await addPlugin(store, mockServer(), text());
        expect(() => rotatePlugin(store, 'hello-board')).toThrow(PluginCliError);
        applyServerInstall(store, 'hello-board', { installId: 'pi_1', state: 'enabled', grants: ['sidebar'], manifestHash: manifestHash(sampleManifest()) });
        const down = mockServer({ disable: async () => { throw new Error('offline'); } });
        const d = await disablePlugin(store, down, 'hello-board', 'testing');
        expect(d.serverNotified).toBe(false);
        expect(store.readInstall('hello-board')).toMatchObject({ localDisabled: true, localDisabledReason: 'testing' });
        expect(enablePlugin(store, 'hello-board').localDisabled).toBeUndefined();
        const before = [store.readToken('hello-board'), store.readSecret('hello-board')];
        rotatePlugin(store, 'hello-board');
        expect(store.readToken('hello-board')).not.toBe(before[0]);
        expect(store.readSecret('hello-board')).not.toBe(before[1]);
        expect(statSync(store.tokenFile('hello-board')).mode & 0o777).toBe(0o600);
        expect(pluginEnv(store, 'hello-board')).toMatchObject({ VH_PLUGIN_TOKEN_FILE: store.tokenFile('hello-board'), VH_PLUGIN_SECRET_FILE: store.secretFile('hello-board') });
        const server = mockServer();
        await removePlugin(store, server, 'hello-board', true);
        expect(server.remove).toHaveBeenCalledWith('pi_1', true);
        expect(existsSync(store.dir('hello-board'))).toBe(false);
    });
});

describe('B-974c manifest sources: only local files or loopback URLs', () => {
    let server: Server | null = null;
    let cleanup = () => {};
    afterEach(async () => { cleanup(); if (server) await new Promise<void>((r) => server!.close(() => r())); server = null; });

    it.each(['https://example.com/vh-plugin.json', 'http://example.com/vh-plugin.json', 'http://localhost:4310/x', 'http://10.0.0.5:4310/x', 'file:///etc/passwd', 'ftp://127.0.0.1:4310/x'])('refuses %s', async (src) => {
        await expect(readManifestSource(src)).rejects.toMatchObject({ code: 'invalid_source' });
    });

    it('reads a local file and a loopback URL, without following redirects', async () => {
        const t = tempHome(); cleanup = t.cleanup;
        const file = join(t.home, 'm.json');
        writeFileSync(file, '{"a":1}');
        expect((await readManifestSource('m.json', t.home)).text).toBe('{"a":1}');
        server = createServer((req, res) => {
            if (req.url === '/redirect') { res.statusCode = 302; res.setHeader('location', 'http://example.com/'); res.end(); return; }
            res.end('{"b":2}');
        });
        await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
        const port = (server.address() as AddressInfo).port;
        expect((await readManifestSource(`http://127.0.0.1:${port}/.well-known/vh-plugin.json`)).text).toBe('{"b":2}');
        await expect(readManifestSource(`http://127.0.0.1:${port}/redirect`)).rejects.toMatchObject({ code: 'source_unreachable' });
    });
});

describe('B-974c server client', () => {
    let server: Server | null = null;
    afterEach(async () => { if (server) await new Promise<void>((r) => server!.close(() => r())); server = null; });

    async function serve(status: number, body: unknown): Promise<string> {
        server = createServer((_req, res) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(typeof body === 'string' ? body : JSON.stringify(body)); });
        await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
        return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }

    it('a 404 route-not-found from an old server is server_too_old', async () => {
        const url = await serve(404, { message: 'Route POST:/v1/plugins/installs not found', error: 'Not Found', statusCode: 404 });
        await expect(new PluginServerClient(url, 't', '0').submitManifest({})).rejects.toMatchObject({ code: 'server_too_old' });
    });

    it('a structured refusal keeps its code', async () => {
        const url = await serve(409, { error: 'already_installed', message: 'x' });
        await expect(new PluginServerClient(url, 't', '0').submitManifest({})).rejects.toMatchObject({ code: 'already_installed', status: 409 });
        await server!.close();
        server = null;
        const url2 = await serve(404, { error: 'not_found', message: 'install' });
        await expect(new PluginServerClient(url2, 't', '0').disable('pi_x')).rejects.toMatchObject({ code: 'not_found' });
    });
});
