import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginHttpForwarder, buildUpstreamHeaders, normalizeForwardPath, rewriteLocation, stripHostCookies, CHUNK_MAX, MAX_CONCURRENT_PER_INSTALL } from './pluginHttp';
import { assertLoopbackTarget } from './loopbackHttp';
import { signPanelRequest } from './signing';
import { installApproved, registryFor, sampleManifest, tempHome } from './testFixtures';
import type { PluginPermission } from './manifest';

const b64 = (s: string) => Buffer.from(s).toString('base64');
const unb64 = (s: string) => Buffer.from(s, 'base64').toString('utf8');

describe('B-974c plugin-http path and header rules (DESIGN §4.6)', () => {
    it.each([
        ['/', true], ['/api/x', true], ['/a%20b', true], ['/a/b.c/', true],
        ['', false], ['api', false], ['//evil.com/x', false], ['/%2F%2Fevil.com', false], ['/a/../b', false], ['/a/%2e%2e/b', false],
        ['/..', false], ['/a/./b', false], ['/a\\b', false], ['/a%5Cb', false], ['/a%00b', false], ['/a\u0000b', false], ['/a b', false],
        ['/a\r\nX: y', false], ['%2Fapi', false], ['%2F%2Fevil.com', false], ['/%E0%A4%A', false], ['http://127.0.0.1/x', false], ['/x#frag', false], ['/x?y', false],
    ])('path %j → %s', (path, ok) => {
        expect(normalizeForwardPath(path, undefined).ok).toBe(ok);
    });

    it('query is appended raw, but must not smuggle CRLF or a fragment', () => {
        expect(normalizeForwardPath('/x', 'a=1&b=%20')).toEqual({ ok: true, pathWithQuery: '/x?a=1&b=%20' });
        expect(normalizeForwardPath('/x', 'a=1\r\nHost: x').ok).toBe(false);
        expect(normalizeForwardPath('/x', 'a#b').ok).toBe(false);
    });

    it('rewrites request headers', () => {
        const out = buildUpstreamHeaders({
            Host: 'hello-board-abcd1234.p.example.test',
            Origin: 'https://hello-board-abcd1234.p.example.test',
            Referer: 'https://hello-board-abcd1234.p.example.test/page?q=1',
            Cookie: '__Host-vhp=frame; theme=dark; __Host-vhp-2=x',
            Connection: 'keep-alive, X-Secret-Hop',
            'X-Secret-Hop': '1',
            'Transfer-Encoding': 'chunked',
            'Proxy-Authorization': 'Basic x',
            'X-VH-Signature': 'forged',
            'X-VH-Viewer': 'attacker',
            'X-Forwarded-For': '1.2.3.4',
            Authorization: 'Bearer plugin-own-auth',
            Accept: 'text/html',
        }, { target: { host: '127.0.0.1', port: 4310 }, pluginId: 'hello-board', signature: { 'X-VH-Viewer': 'owner', 'X-VH-Signature': 'v1=real' } });
        expect(out).toEqual({
            host: '127.0.0.1:4310',
            origin: 'http://127.0.0.1:4310',
            referer: 'http://127.0.0.1:4310/page?q=1',
            cookie: 'theme=dark',
            authorization: 'Bearer plugin-own-auth',
            accept: 'text/html',
            'x-forwarded-proto': 'https',
            'x-forwarded-host': 'hello-board-abcd1234.p.example.test',
            'x-vh-viewer': 'owner',
            'x-vh-signature': 'v1=real',
        });
    });

    it('drops a foreign Origin / Referer and a sibling plugin host', () => {
        const out = buildUpstreamHeaders({ host: 'other-plugin-1234abcd.p.example.test', origin: 'https://other-plugin-1234abcd.p.example.test', referer: 'https://evil.test/' }, { target: { host: '::1', port: 5000 }, pluginId: 'hello-board', signature: {} });
        expect(out).toEqual({ host: '[::1]:5000', 'x-forwarded-proto': 'https' });
        expect(stripHostCookies('__Host-vhp=1')).toBe('');
    });

    it('Location to the upstream becomes a relative path; others stay', () => {
        const t = { host: '127.0.0.1' as const, port: 4310 };
        expect(rewriteLocation('http://127.0.0.1:4310/next?a=1#h', t)).toBe('/next?a=1#h');
        expect(rewriteLocation('http://127.0.0.1:4311/next', t)).toBe('http://127.0.0.1:4311/next');
        expect(rewriteLocation('http://localhost:4310/next', t)).toBe('http://localhost:4310/next');
        expect(rewriteLocation('https://example.test/', t)).toBe('https://example.test/');
        expect(rewriteLocation('/rel', t)).toBe('/rel');
    });

    it('the socket layer refuses anything but the loopback literals', () => {
        for (const host of ['localhost', '127.0.0.2', '0.0.0.0', '169.254.169.254', 'example.com', '::ffff:127.0.0.1']) {
            expect(() => assertLoopbackTarget({ host, port: 4310 })).toThrow();
        }
        expect(() => assertLoopbackTarget({ host: '127.0.0.1', port: 80 })).toThrow();
        expect(() => assertLoopbackTarget({ host: '127.0.0.1', port: 4310 })).not.toThrow();
    });
});

describe('B-974c plugin-http forwarding against a real loopback upstream', () => {
    let server: Server | null = null;
    let cleanup = () => {};
    const seen: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: string }> = [];
    let handler: (req: IncomingMessage, res: ServerResponse, body: string) => void = (_q, res) => { res.end('ok'); };

    async function setup(grants?: PluginPermission[]) {
        seen.length = 0;
        server = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => { const body = Buffer.concat(chunks).toString('utf8'); seen.push({ method: req.method!, url: req.url!, headers: req.headers, body }); handler(req, res, body); });
        });
        await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
        const port = (server.address() as AddressInfo).port;
        const t = tempHome(); cleanup = t.cleanup;
        const { store, registry } = registryFor(t.home);
        const m = sampleManifest({ panels: [{ id: 'main', title: 'Main', upstream: `http://127.0.0.1:${port}` }], callback: { url: `http://127.0.0.1:${port}/vh/callback` } });
        const { secret } = installApproved(store, m, { grants });
        registry.reload();
        return { port, store, registry, secret, fwd: new PluginHttpForwarder(registry, { timeoutMs: 2_000 }) };
    }

    afterEach(async () => {
        cleanup();
        handler = (_q, res) => { res.end('ok'); };
        if (server) await new Promise<void>((r) => server!.close(() => r()));
        server = null;
    });

    const req = (over: Record<string, unknown> = {}) => ({ reqId: 'req_1', installId: 'pi_hello-board', panelId: 'main', method: 'POST', path: '/api/count', query: 'a=1', headers: { host: 'hello-board-abcd1234.p.example.test', 'content-type': 'application/json' }, bodyB64: b64('{"n":1}'), ...over });

    it('forwards to the declared port with a verifiable signature', async () => {
        const { fwd, secret } = await setup();
        handler = (_q, res) => { res.setHeader('x-plugin', 'yes'); res.setHeader('connection', 'close'); res.end('{"count":1}'); };
        const r = await fwd.handle(req());
        expect(r.status).toBe(200);
        expect(unb64(r.bodyB64)).toBe('{"count":1}');
        expect(r.headers['x-plugin']).toBe('yes');
        expect(r.headers.connection).toBeUndefined();
        const got = seen[0];
        expect(got).toMatchObject({ method: 'POST', url: '/api/count?a=1', body: '{"n":1}' });
        expect(got.headers['x-vh-install']).toBe('pi_hello-board');
        expect(got.headers['x-vh-viewer']).toBe('owner');
        const ts = Number(got.headers['x-vh-timestamp']);
        expect(got.headers['x-vh-signature']).toBe(signPanelRequest(secret, ts, 'req_1', 'POST', '/api/count?a=1', Buffer.from('{"n":1}')));
    });

    it('does not follow redirects; rewrites Location back to the upstream', async () => {
        const { fwd, port } = await setup();
        handler = (_q, res) => { res.statusCode = 302; res.setHeader('location', `http://127.0.0.1:${port}/landing`); res.end(); };
        const r = await fwd.handle(req({ method: 'GET', bodyB64: undefined }));
        expect(r.status).toBe(302);
        expect(r.headers.location).toBe('/landing');
        expect(seen).toHaveLength(1);
    });

    it('refuses without the panel grant, for an unknown panel, bad path, upgrade', async () => {
        const { fwd } = await setup(['sidebar']);
        expect(JSON.parse(unb64((await fwd.handle(req())).bodyB64))).toMatchObject({ error: 'permission_denied', permission: 'panel' });
        expect(seen).toHaveLength(0);
    });

    it('routes only by panelId; a request cannot name a target', async () => {
        const { fwd } = await setup();
        expect((await fwd.handle(req({ panelId: 'nope' }))).status).toBe(404);
        expect((await fwd.handle(req({ path: '//169.254.169.254/latest' }))).status).toBe(400);
        expect((await fwd.handle(req({ path: '/%2e%2e/etc' }))).status).toBe(400);
        expect((await fwd.handle(req({ installId: 'pi_other' }))).status).toBe(404);
        expect((await fwd.handle(req({ headers: { upgrade: 'websocket', connection: 'Upgrade' } }))).status).toBe(501);
        expect(seen).toHaveLength(0);
    });

    it('ignores HTTP_PROXY and never resolves names', async () => {
        const { fwd } = await setup();
        const saved = { HTTP_PROXY: process.env.HTTP_PROXY, http_proxy: process.env.http_proxy };
        process.env.HTTP_PROXY = 'http://127.0.0.1:1'; process.env.http_proxy = 'http://127.0.0.1:1';
        try {
            expect((await fwd.handle(req())).status).toBe(200);
        } finally {
            for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    });

    it('502 when nothing listens, SSE refused', async () => {
        const { fwd } = await setup();
        handler = (_q, res) => { res.setHeader('content-type', 'text/event-stream'); res.write('data: 1\n\n'); };
        expect((await fwd.handle(req())).status).toBe(501);
        await new Promise<void>((r) => server!.close(() => r()));
        server = null;
        expect(JSON.parse(unb64((await fwd.handle(req())).bodyB64))).toMatchObject({ error: 'upstream_unreachable' });
    });

    it('large responses come back in ≤512KB chunks via plugin-http-pull', async () => {
        const { fwd } = await setup();
        const big = Buffer.alloc(CHUNK_MAX * 2 + 1000, 'x');
        handler = (_q, res) => res.end(big);
        const first = await fwd.handle(req({ method: 'GET', bodyB64: undefined }));
        expect(first.streamId).toBeTruthy();
        let total = Buffer.from(first.bodyB64, 'base64').length;
        expect(total).toBeLessThanOrEqual(CHUNK_MAX);
        let seq = 1;
        for (;;) {
            const next = await fwd.pull({ streamId: first.streamId, seq });
            if ('error' in next) throw new Error(next.error);
            total += Buffer.from(next.chunkB64, 'base64').length;
            seq++;
            if (next.end) break;
        }
        expect(total).toBe(big.length);
        expect(fwd.inFlightCount('pi_hello-board')).toBe(0);
    });

    it('chunked request bodies are reassembled; out-of-order chunks refused', async () => {
        const { fwd } = await setup();
        expect(fwd.acceptBodyChunk({ installId: 'pi_hello-board', streamId: 'b1', seq: 0, chunkB64: b64('hello '), end: false })).toEqual({ ok: true });
        expect(fwd.acceptBodyChunk({ installId: 'pi_hello-board', streamId: 'b1', seq: 2, chunkB64: b64('x') })).toEqual({ error: 'invalid_request' });
        expect(fwd.acceptBodyChunk({ installId: 'pi_hello-board', streamId: 'b1', seq: 1, chunkB64: b64('world'), end: true })).toEqual({ ok: true });
        const r = await fwd.handle(req({ bodyB64: undefined, bodyStreamId: 'b1' }));
        expect(r.status).toBe(200);
        expect(seen[0].body).toBe('hello world');
    });

    it(`caps concurrency at ${MAX_CONCURRENT_PER_INSTALL} per install`, async () => {
        const { fwd } = await setup();
        const held: ServerResponse[] = [];
        handler = (_q, res) => { held.push(res); };
        const pending = Array.from({ length: MAX_CONCURRENT_PER_INSTALL }, () => fwd.handle(req()));
        await new Promise((r) => setTimeout(r, 300));
        const over = await fwd.handle(req());
        expect(over.status).toBe(429);
        for (const res of held) res.end('done');
        expect((await Promise.all(pending)).every((r) => r.status === 200)).toBe(true);
        expect(fwd.inFlightCount('pi_hello-board')).toBe(0);
    });
});
