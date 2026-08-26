import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
