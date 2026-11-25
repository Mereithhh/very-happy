import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startDaemonControlServer } from '@/daemon/controlServer';
import type { PluginApiRequest } from './localApi';

/** B-974c: `/plugin/v1/*` lives on the control port but never accepts — or needs — the control token. */
describe('B-974c daemon routes', () => {
    const controlToken = 'test-control-token-with-at-least-256-bits-of-material';
    const handleApi = vi.fn(async (req: PluginApiRequest) => (req.headers.authorization === 'Bearer vhp_good'
        ? { status: 200, body: { path: req.path, query: req.query, body: req.body as any } }
        : { status: 401, body: { error: 'unauthorized', message: 'no' } }));
    const requestShutdown = vi.fn();
    let port: number;
    let stop: () => Promise<void>;

    beforeAll(async () => {
        const server = await startDaemonControlServer({
            controlToken,
            getChildren: () => [],
            stopSession: () => false,
            spawnSession: async () => ({ type: 'error', errorMessage: 'not implemented' }),
            requestShutdown,
            onHappySessionWebhook: () => { },
            pushClipboard: () => ({ delivered: false, truncated: false, totalBytes: 0 }),
            plugins: { handleApi, reload: () => [{ id: 'x' }], ping: async () => ({ status: 200 }) },
        });
        port = server.port;
        stop = server.stop;
    });
    afterAll(async () => { await stop(); });

    const req = (method: string, path: string, headers: Record<string, string> = {}, body?: string) => fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body });

    it('plugin routes reach the plugin handler without the control token', async () => {
        const r = await req('PUT', '/plugin/v1/badge?x=1', { authorization: 'Bearer vhp_good', 'content-type': 'application/json' }, '{"count":1}');
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ path: '/badge', query: { x: '1' }, body: { count: 1 } });
        expect((await req('GET', '/plugin/v1/info')).status).toBe(401);
    });

    it('a plugin token never opens a control route, and path tricks do not bypass the control gate', async () => {
        for (const path of ['/stop', '/plugin/v1/../stop', '/plugin/v1/%2e%2e/stop', '/plugins/reload', '//plugin/v1/x', '/plugin/v1']) {
            const r = await req('POST', path, { authorization: 'Bearer vhp_good', 'content-type': 'application/json' }, '{}');
            if (path.startsWith('/plugin/v1/')) {
                // fetch may normalise `..` to /stop (→ 401); otherwise it stays a plugin route. Never /stop itself.
                expect([200, 401, 404], `${path} → ${r.status}`).toContain(r.status);
            } else {
                expect(r.status).toBe(401);
            }
        }
        await new Promise((r) => setTimeout(r, 100));
        expect(requestShutdown).not.toHaveBeenCalled();
        expect((await req('POST', '/plugins/reload', { authorization: `Bearer ${controlToken}`, 'content-type': 'application/json' }, '{}')).status).toBe(200);
    });

    it('JSON only, at most 64KB', async () => {
        expect(await (await req('PUT', '/plugin/v1/badge', { authorization: 'Bearer vhp_good', 'content-type': 'text/plain' }, 'x')).json()).toMatchObject({ error: 'invalid_request' });
        const big = JSON.stringify({ bodyMd: 'x'.repeat(65 * 1024) });
        const r = await req('POST', '/plugin/v1/decisions', { authorization: 'Bearer vhp_good', 'content-type': 'application/json' }, big);
        expect(r.status).toBe(413);
        expect(await r.json()).toMatchObject({ error: 'payload_too_large' });
        expect((await req('POST', '/plugin/v1/decisions', { authorization: 'Bearer vhp_good', 'content-type': 'application/json' }, '{bad')).status).toBe(400);
    });
});
