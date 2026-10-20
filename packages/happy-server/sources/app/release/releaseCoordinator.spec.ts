import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import fastify from 'fastify';
import { ReleaseCoordinator, releaseWebAsset } from './releaseCoordinator';

vi.mock('@/storage/db', () => ({ db: { $queryRaw: vi.fn(async () => [{ '?column?': 1 }]) } }));

const opened: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
    await Promise.all(opened.splice(0).map((app) => app.close()));
});

describe('releaseWebAsset', () => {
    it('requires the exact immutable release asset', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-release-'));
        try {
            fs.writeFileSync(path.join(dir, 'index.html'), '<script src="/assets/index-abc-' + 'a'.repeat(40) + '.js"></script>');
            expect(releaseWebAsset(dir, 'a'.repeat(40))).toBe('/assets/index-abc-' + 'a'.repeat(40) + '.js');
            expect(releaseWebAsset(dir, 'b'.repeat(40))).toBeNull();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('ReleaseCoordinator admin contract', () => {
    function createFixture() {
        const app = fastify();
        opened.push(app);
        const sockets = new Map();
        const localEmit = vi.fn();
        const io: any = {
            on: vi.fn(),
            of: vi.fn(() => ({ sockets })),
            local: { emit: localEmit, disconnectSockets: vi.fn(() => sockets.clear()) },
            serverSideEmitWithAck: vi.fn(async (_event: string, probe: { nonce: string }) => [
                { nonce: probe.nonce, slot: 'green', release: 'b'.repeat(40) },
            ]),
        };
        const redis: any = { ping: vi.fn(async () => 'PONG') };
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-release-admin-'));
        fs.writeFileSync(path.join(dir, 'index.html'), `<script src="/assets/index-${'a'.repeat(40)}.js"></script>`);
        const coordinator = new ReleaseCoordinator({
            app: app as any,
            io,
            redis,
            staticDir: dir,
            adapterReadyAt: 0,
            config: { slot: 'blue', release: 'a'.repeat(40), adminToken: 't'.repeat(32), adapterWarmupMs: 1 },
        });
        coordinator.register();
        return { app, io, localEmit, dir };
    }

    it('hides admin routes without the release token and reports exact readiness with it', async () => {
        const { app, dir } = createFixture();
        try {
            expect((await app.inject({ method: 'GET', url: '/_vh/release/ready' })).statusCode).toBe(404);
            const response = await app.inject({
                method: 'GET', url: '/_vh/release/ready', headers: { 'x-vh-release-token': 't'.repeat(32) },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({ status: 'ready', slot: 'blue', release: 'a'.repeat(40) });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('emits a fixed-slot make-before-break notice and refuses arbitrary candidates', async () => {
        const { app, localEmit, dir } = createFixture();
        const headers = { 'x-vh-release-token': 't'.repeat(32) };
        const body = {
            epoch: 'release-1234',
            toRelease: 'b'.repeat(40),
            candidateSlot: 'green',
            deadline: Date.now() + 60_000,
        };
        try {
            const accepted = await app.inject({ method: 'POST', url: '/_vh/release/drain', headers, payload: body });
            expect(accepted.statusCode).toBe(200);
            expect(localEmit).toHaveBeenCalledWith('server-draining', expect.objectContaining({
                candidateSlot: 'green', mode: 'make-before-break', fromRelease: 'a'.repeat(40),
            }));
            const rejected = await app.inject({
                method: 'POST', url: '/_vh/release/drain', headers,
                payload: { ...body, candidateSlot: 'http://attacker.invalid' },
            });
            expect(rejected.statusCode).toBe(400);

            const cancelled = await app.inject({
                method: 'POST', url: '/_vh/release/cancel', headers,
            });
            expect(cancelled.statusCode).toBe(200);
            expect(cancelled.json()).toMatchObject({ state: 'accepting', epoch: null });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('requires an acknowledged canary from the opposite slot', async () => {
        const { app, io, dir } = createFixture();
        const headers = { 'x-vh-release-token': 't'.repeat(32) };
        try {
            expect((await app.inject({ method: 'POST', url: '/_vh/release/canary', headers })).statusCode).toBe(200);
            io.serverSideEmitWithAck.mockImplementationOnce(async (_event: string, probe: { nonce: string }) => [
                { nonce: probe.nonce, slot: 'blue', release: 'a'.repeat(40) },
            ]);
            expect((await app.inject({ method: 'POST', url: '/_vh/release/canary', headers })).statusCode).toBe(503);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('ReleaseCoordinator in-flight HTTP accounting (B-546)', () => {
    async function listen() {
        const app = fastify();
        opened.push(app);
        const io: any = { on: vi.fn(), of: vi.fn(() => ({ sockets: new Map() })), local: { emit: vi.fn(), disconnectSockets: vi.fn() } };
        const coordinator = new ReleaseCoordinator({
            app: app as any, io, redis: { ping: vi.fn(async () => 'PONG') } as any, adapterReadyAt: 0,
            config: { slot: 'blue', release: 'a'.repeat(40), adminToken: 't'.repeat(32), adapterWarmupMs: 1 },
        });
        coordinator.register();
        let handlerDone!: () => void;
        const handlerFinished = new Promise<void>((resolve) => { handlerDone = resolve; });
        app.post('/slow', async () => { await new Promise((resolve) => setTimeout(resolve, 200)); handlerDone(); return { ok: true }; });
        app.get('/slow', async () => { await new Promise((resolve) => setTimeout(resolve, 200)); handlerDone(); return { ok: true }; });
        app.post('/fast', async () => ({ ok: true }));
        await app.listen({ port: 0, host: '127.0.0.1' });
        const port = (app.server.address() as { port: number }).port;
        const status = async () => (await app.inject({ method: 'GET', url: '/_vh/release/status', headers: { 'x-vh-release-token': 't'.repeat(32) } })).json();
        return { port, status, handlerFinished };
    }

    /** A request whose client goes away 50 ms in, while the handler is still running. */
    function abandon(port: number, method: 'GET' | 'POST', path: string): Promise<void> {
        return new Promise((resolve) => {
            const body = method === 'POST' ? JSON.stringify({ hello: 'world' }) : undefined;
            const req = http.request({ host: '127.0.0.1', port, method, path, headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {} });
            req.on('error', () => resolve());
            if (body) req.write(body);
            req.end();
            setTimeout(() => { req.destroy(); resolve(); }, 50);
        });
    }

    it('a POST whose client disconnects mid-handler is released (Fastify runs no hook for it)', async () => {
        const { port, status, handlerFinished } = await listen();
        await abandon(port, 'POST', '/slow');
        await handlerFinished;
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect((await status()).inFlightHttp).toBe(0);
    });

    it('an abandoned GET and a completed POST are released once each, never below zero', async () => {
        const { port, status, handlerFinished } = await listen();
        await abandon(port, 'GET', '/slow');
        await handlerFinished;
        await new Promise<void>((resolve) => {
            const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/fast', headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve()); });
            req.end('{}');
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect((await status())).toMatchObject({ inFlightHttp: 0, oldestInFlightHttp: [] });
    });

    it('status names the oldest in-flight requests while they run', async () => {
        const { port, status, handlerFinished } = await listen();
        const done = new Promise<void>((resolve) => {
            const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/slow?x=1', headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve()); });
            req.end('{}');
        });
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(await status()).toMatchObject({ inFlightHttp: 1, oldestInFlightHttp: [{ method: 'POST', url: '/slow' }] });
        await handlerFinished;
        await done;
    });
});
