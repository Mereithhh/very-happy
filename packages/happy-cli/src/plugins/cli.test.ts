import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginCliError, absoluteReviewUrl, addPlugin, disablePlugin, enablePlugin, pluginEnv, readManifestSource, removePlugin, rotatePlugin, updatePlugin, type PluginServerApi } from './cli';
import { PluginServerClient, PluginServerError, originHostsFromInstalls, pluginSupportFromFeatures, serverTooOldFrom404 } from './serverOp';
import { enableMessages } from '@/commands/plugin';
import { manifestHash } from './manifest';
import { applyServerInstall, PluginStore } from './store';
import { sampleManifest, tempHome } from './testFixtures';

function mockServer(over: Partial<PluginServerApi> = {}): PluginServerApi & { submitManifest: ReturnType<typeof vi.fn> } {
    return {
        submitManifest: vi.fn(async () => ({ installId: 'pi_1', state: 'pending', reviewUrl: 'https://web.example.test/settings/plugins/pi_1/review' })),
        disable: vi.fn(async () => ({})),
        enable: vi.fn(async () => ({})),
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

    it('add again (r2): rejected resubmits; removed with a new installId starts over; other states refuse', async () => {
        const t = tempHome(); cleanup = t.cleanup;
        const store = new PluginStore(t.home);
        await addPlugin(store, mockServer(), text());
        applyServerInstall(store, 'hello-board', { installId: 'pi_1', state: 'rejected', grants: [], manifestHash: null });
        const again = await addPlugin(store, mockServer(), text());
        expect(again).toMatchObject({ installId: 'pi_1', state: 'pending' });
        // Approved, then removed on the account side; a fresh add gets a new install and no old credentials.
        applyServerInstall(store, 'hello-board', { installId: 'pi_1', state: 'enabled', grants: ['sidebar'], manifestHash: manifestHash(sampleManifest()) });
        const oldToken = store.readToken('hello-board');
        expect(oldToken).toMatch(/^vhp_/);
        store.writeInstall('hello-board', { ...store.readInstall('hello-board')!, state: 'removed' });
        const fresh = await addPlugin(store, mockServer({ submitManifest: async () => ({ installId: 'pi_2', state: 'pending', reviewUrl: 'r' }) }), text());
        expect(fresh).toMatchObject({ installId: 'pi_2', state: 'pending' });
        expect(store.readToken('hello-board')).toBeNull();
        expect(store.readApprovedManifest('hello-board')).toBeNull();
        for (const state of ['pending', 'enabled', 'disabled', 'disabled_by_operator'] as const) {
            store.writeInstall('hello-board', { ...store.readInstall('hello-board')!, state });
            await expect(addPlugin(store, mockServer(), text())).rejects.toMatchObject({ code: 'already_installed' });
        }
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
        expect((await enablePlugin(store, mockServer(), 'hello-board')).record.localDisabled).toBeUndefined();
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

describe('B-974c server capability (r2)', () => {
    it.each([
        [200, { features: ['plugins-v1', 'x'] }, 'yes'],
        [200, { features: { 'plugins-v1': true } }, 'no'],
        [200, { features: ['x'] }, 'no'],
        [200, { features: { 'plugins-v1': false } }, 'no'],
        [200, {}, 'no'],
        [404, { error: 'Not Found' }, 'no'],
        [502, null, 'unknown'],
    ] as const)('HTTP %i %j → %s', (status, data, expected) => {
        expect(pluginSupportFromFeatures(status, data)).toBe(expected);
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
        await expect(new PluginServerClient(url, 't', '0', 'm-1').submitManifest({})).rejects.toMatchObject({ code: 'server_too_old' });
    });

    it('every machine-token call names this machine (X-VH-Machine-Id; body machineId on POST)', async () => {
        const seen: Array<{ method: string; url: string; machine: unknown; body: string }> = [];
        server = createServer((req, res) => {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                seen.push({ method: req.method!, url: req.url!, machine: req.headers['x-vh-machine-id'], body });
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ installId: 'pi_1', state: 'pending', reviewUrl: 'r', manifestHash: 'h' }));
            });
        });
        await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
        const client = new PluginServerClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 't', '0', 'm-1');
        await client.submitManifest({ id: 'x' });
        await client.disable('pi_1', 'why');
        await client.remove('pi_1', false);
        expect(seen.map((s) => [s.method, s.url, s.machine])).toEqual([
            ['POST', '/v1/plugins/installs', 'm-1'],
            ['POST', '/v1/plugins/installs/pi_1/disable', 'm-1'],
            ['DELETE', '/v1/plugins/installs/pi_1', 'm-1'],
        ]);
        expect(JSON.parse(seen[0].body)).toEqual({ manifest: { id: 'x' }, machineId: 'm-1' });
    });

    it('404 plugins_disabled (switch off for the account) is server_too_old too', async () => {
        const url = await serve(404, { error: 'plugins_disabled' });
        await expect(new PluginServerClient(url, 't', '0', 'm-1').submitManifest({})).rejects.toMatchObject({ code: 'server_too_old' });
    });

    it('a structured refusal keeps its code', async () => {
        const url = await serve(409, { error: 'already_installed', message: 'x' });
        await expect(new PluginServerClient(url, 't', '0', 'm-1').submitManifest({})).rejects.toMatchObject({ code: 'already_installed', status: 409 });
        await server!.close();
        server = null;
        const url2 = await serve(404, { error: 'not_found', message: 'install' });
        await expect(new PluginServerClient(url2, 't', '0', 'm-1').disable('pi_x')).rejects.toMatchObject({ code: 'not_found' });
    });
});

describe('B-974h plugin enable (P2-2): local first, then the machine-token /enable', () => {
    let cleanup = () => {};
    afterEach(() => cleanup());
    const text = () => ({ text: JSON.stringify(sampleManifest()), source: '/tmp/vh-plugin.json' });
    async function installed(state: 'enabled' | 'disabled' | 'disabled_by_operator' = 'enabled') {
        const t = tempHome(); cleanup = t.cleanup;
        const store = new PluginStore(t.home);
        await addPlugin(store, mockServer(), text());
        applyServerInstall(store, 'hello-board', { installId: 'pi_1', state, grants: ['sidebar'], manifestHash: manifestHash(sampleManifest()) });
        return store;
    }

    it('after a local disable (server not yet synced) enable lifts both: the local flag and the machine disable', async () => {
        const store = await installed();
        await disablePlugin(store, mockServer(), 'hello-board');
        const server = mockServer();
        const r = await enablePlugin(store, server, 'hello-board');
        expect(server.enable).toHaveBeenCalledWith('pi_1');
        expect(r.server).toEqual({ kind: 'enabled' });
        expect(store.readInstall('hello-board')).toMatchObject({ state: 'enabled' });
        expect(store.readInstall('hello-board')?.localDisabled).toBeUndefined();
    });

    it('a synced machine disable (state disabled) is lifted and shown enabled at once', async () => {
        const store = await installed('disabled');
        store.writeInstall('hello-board', { ...store.readInstall('hello-board')!, localDisabled: true });
        const r = await enablePlugin(store, mockServer(), 'hello-board');
        expect(r).toMatchObject({ server: { kind: 'enabled' }, record: { state: 'enabled' } });
    });

    it('403 enable_requires_owner (account / another machine) → local flag cleared, web needed', async () => {
        const store = await installed('disabled');
        store.writeInstall('hello-board', { ...store.readInstall('hello-board')!, localDisabled: true });
        const r = await enablePlugin(store, mockServer({ enable: async () => { throw new PluginServerError('enable_requires_owner', 'x', 403); } }), 'hello-board');
        expect(r.server).toEqual({ kind: 'requires_owner' });
        expect(store.readInstall('hello-board')).toMatchObject({ state: 'disabled' });
        expect(store.readInstall('hello-board')?.localDisabled).toBeUndefined();
        const lines = enableMessages('hello-board', r.record, r.server, 'https://web.example.test/').map((l) => l.text).join('\n');
        expect(lines).toContain('https://web.example.test/settings/plugins');
        expect(lines).toContain('cannot undo');
    });

    it('409 not_disabled means nothing to lift; an unreachable server only changes local state', async () => {
        const store = await installed();
        expect((await enablePlugin(store, mockServer({ enable: async () => { throw new PluginServerError('not_disabled', 'x', 409); } }), 'hello-board')).server).toEqual({ kind: 'enabled' });
        const r = await enablePlugin(store, mockServer({ enable: async () => { throw new Error('offline'); } }), 'hello-board');
        expect(r.server).toEqual({ kind: 'not_sent', error: 'offline' });
        expect(enableMessages('hello-board', r.record, r.server, 'https://w.test').some((l) => l.warn && l.text.includes('not told'))).toBe(true);
    });

    it('operator disable is never sent and says only the operator can lift it', async () => {
        const store = await installed('disabled_by_operator');
        const server = mockServer();
        const r = await enablePlugin(store, server, 'hello-board');
        expect(server.enable).not.toHaveBeenCalled();
        expect(enableMessages('hello-board', r.record, r.server, 'https://w.test').map((l) => l.text).join('\n')).toContain('operator');
    });

    it('request shape: POST /v1/plugins/installs/:id/enable with the machine id (header and body)', async () => {
        const seen: Array<{ method: string; url: string; machine: unknown; auth: unknown; body: string }> = [];
        const srv = createServer((req, res) => {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                seen.push({ method: req.method!, url: req.url!, machine: req.headers['x-vh-machine-id'], auth: req.headers.authorization, body });
                res.statusCode = seen.length === 1 ? 200 : 403;
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify(seen.length === 1 ? { install: { id: 'pi_1', state: 'enabled' } } : { error: 'enable_requires_owner' }));
            });
        });
        await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
        try {
            const client = new PluginServerClient(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`, 'machine-token', '0', 'm-1');
            await client.enable('pi_1');
            await expect(client.enable('pi_1')).rejects.toMatchObject({ code: 'enable_requires_owner', status: 403 });
            expect(seen[0]).toMatchObject({ method: 'POST', url: '/v1/plugins/installs/pi_1/enable', machine: 'm-1', auth: 'Bearer machine-token' });
            expect(JSON.parse(seen[0].body)).toEqual({ machineId: 'm-1' });
        } finally {
            await new Promise<void>((r) => srv.close(() => r()));
        }
    });
});

describe('B-974h P3-3: a 404 from an older server is server_too_old', () => {
    it.each([
        [{ error: 'Not found', path: '/v1/plugins/installs', method: 'POST' }, true],   // happy-server's generic not-found handler (R83)
        [{ message: 'Route POST:/v1/plugins/installs not found', error: 'Not Found', statusCode: 404 }, true], // Fastify default
        ['Not found', true],
        ['<html>404</html>', true],
        ['', true],
        [{}, true],
        [{ error: 'plugins_disabled' }, true],
        [{ error: 'not_found', message: 'install' }, false],
    ] as const)('404 %j → too old: %s', (body, tooOld) => {
        expect(serverTooOldFrom404(404, body) !== null).toBe(tooOld);
    });

    it('only 404 is considered', () => {
        expect(serverTooOldFrom404(403, { error: 'Not found' })).toBeNull();
    });

    it('end to end: R83 body through the client', async () => {
        const srv = createServer((_req, res) => { res.statusCode = 404; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: 'Not found', path: '/v1/plugins/installs', method: 'POST' })); });
        await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
        try {
            await expect(new PluginServerClient(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`, 't', '0', 'm-1').submitManifest({})).rejects.toMatchObject({ code: 'server_too_old' });
        } finally {
            await new Promise<void>((r) => srv.close(() => r()));
        }
    });
});

describe('B-974h P3-4: review links are absolute on the web app origin', () => {
    it.each([
        ['/settings/plugins/pi_1/review', 'https://web.example.test', 'https://web.example.test/settings/plugins/pi_1/review'],
        ['/settings/plugins/pi_1/review', 'https://web.example.test/', 'https://web.example.test/settings/plugins/pi_1/review'],
        ['https://other.example.test/x', 'https://web.example.test', 'https://other.example.test/x'],
        ['//evil.example.test/x', 'https://web.example.test', '//evil.example.test/x'],
    ] as const)('%s on %s', (path, web, expected) => {
        expect(absoluteReviewUrl(path, web)).toBe(expected);
    });
    it('nothing in, nothing out', () => {
        expect(absoluteReviewUrl(undefined, 'https://w.test')).toBeNull();
        expect(absoluteReviewUrl('', 'https://w.test')).toBeNull();
    });
});

describe('B-974h P3-9: install origins from GET /v1/plugins/installs', () => {
    it('keeps http(s) origins (dev servers use http and a port), keyed by install id', () => {
        const map = originHostsFromInstalls({ installs: [
            { id: 'pi_1', origin: 'https://hello-board-abcdefgh.plugins.example.test' },
            { id: 'pi_2', origin: null },
            { id: 'pi_3', origin: 'http://x-abcdefgh.localhost:5350' },
            { id: 'pi_4', origin: 'https://u:p@x.example.test' },
            { origin: 'https://no-id.example.test' },
        ] });
        expect([...map]).toEqual([['pi_1', 'hello-board-abcdefgh.plugins.example.test'], ['pi_3', 'x-abcdefgh.localhost:5350']]);
        expect(originHostsFromInstalls(null).size).toBe(0);
    });
});
