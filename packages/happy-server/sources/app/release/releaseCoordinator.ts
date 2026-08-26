import { timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Redis } from 'ioredis';
import type { Server } from 'socket.io';
import { db } from '@/storage/db';
import type { Fastify } from '@/app/api/types';
import type { ReleaseConfig, ReleaseSlot } from './releaseConfig';
import type { ReleaseDrainNotice } from '@slopus/happy-wire';
import {
    releaseDrainingGauge,
    releaseInflightHttpGauge,
    releaseInflightRpcGauge,
    releaseLocalConnectionsGauge,
    releaseSlotReadyGauge,
} from '@/app/monitoring/metrics2';

type DrainState = {
    epoch: string | null;
    state: 'accepting' | 'draining' | 'drained';
    notice: ReleaseDrainNotice | null;
};

export type ReleaseReadiness = {
    status: 'ready' | 'not-ready';
    release: string;
    slot: ReleaseSlot;
    database: 'ready' | 'failed';
    redis: 'ready' | 'failed';
    socketAdapter: 'ready' | 'warming' | 'failed';
    webAsset: string | null;
};

type CoordinatorOptions = {
    app: Fastify;
    io: Server;
    config: ReleaseConfig;
    redis: Redis;
    adapterReadyAt: number;
    staticDir?: string;
};

function safeTokenEqual(actual: string | undefined, expected: string): boolean {
    if (!actual) return false;
    const left = Buffer.from(actual);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
}

export function releaseWebAsset(staticDir: string | undefined, release: string): string | null {
    if (!staticDir) return null;
    const indexPath = path.join(staticDir, 'index.html');
    if (!fs.existsSync(indexPath)) return null;
    const html = fs.readFileSync(indexPath, 'utf8');
    const assets = html.match(/\/assets\/[^"']+\.js/g) ?? [];
    return assets.find((asset) => asset.endsWith(`-${release}.js`)) ?? null;
}

export class ReleaseCoordinator {
    private readonly app: Fastify;
    private readonly io: Server;
    private readonly config: ReleaseConfig;
    private readonly redis: Redis;
    private readonly adapterReadyAt: number;
    private readonly staticDir?: string;
    private readonly trackedRequests = new WeakSet<object>();
    private inFlightHttp = 0;
    private inFlightRpc = 0;
    private drain: DrainState = { epoch: null, state: 'accepting', notice: null };

    constructor(options: CoordinatorOptions) {
        this.app = options.app;
        this.io = options.io;
        this.config = options.config;
        this.redis = options.redis;
        this.adapterReadyAt = options.adapterReadyAt;
        this.staticDir = options.staticDir;
    }

    register(): void {
        this.app.addHook('onRequest', async (request) => {
            if (request.url.startsWith('/_vh/release/')) return;
            this.trackedRequests.add(request);
            this.inFlightHttp += 1;
        });
        const finishRequest = async (request: object) => {
            if (!this.trackedRequests.delete(request)) return;
            this.inFlightHttp = Math.max(0, this.inFlightHttp - 1);
            this.refreshDrainedState();
        };
        this.app.addHook('onResponse', async (request) => finishRequest(request));
        this.app.addHook('onError', async (request) => finishRequest(request));
        this.app.addHook('onRequestAbort', async (request) => finishRequest(request));
        this.app.addHook('onTimeout', async (request) => finishRequest(request));

        this.io.on('vh-release-canary', (probe: unknown, callback?: (response: unknown) => void) => {
            if (typeof callback !== 'function') return;
            const nonce = typeof probe === 'object' && probe !== null && typeof (probe as any).nonce === 'string'
                ? (probe as any).nonce
                : '';
            callback({ nonce, slot: this.config.slot, release: this.config.release });
        });
        this.io.on('connection', (socket) => {
            if (this.drain.state === 'draining' && this.drain.notice) {
                socket.emit('server-draining', this.drain.notice);
            }
        });

        this.app.get('/_vh/release/ready', async (request, reply) => {
            if (!this.authorized(request.headers['x-vh-release-token'])) return reply.code(404).send({ error: 'not_found' });
            const readiness = await this.readiness();
            return reply.code(readiness.status === 'ready' ? 200 : 503).send(readiness);
        });

        this.app.get('/_vh/release/status', async (request, reply) => {
            if (!this.authorized(request.headers['x-vh-release-token'])) return reply.code(404).send({ error: 'not_found' });
            this.refreshDrainedState();
            return reply.send(this.status());
        });

        this.app.post('/_vh/release/canary', async (request, reply) => {
            if (!this.authorized(request.headers['x-vh-release-token'])) return reply.code(404).send({ error: 'not_found' });
            const nonce = `${this.config.slot}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            try {
                const responses = await this.io.serverSideEmitWithAck('vh-release-canary', { nonce });
                const peers = responses.filter((response: any) => response?.nonce === nonce
                    && (response?.slot === 'blue' || response?.slot === 'green')
                    && response.slot !== this.config.slot
                    && /^[0-9a-f]{40}$/.test(response?.release));
                if (peers.length < 1) return reply.code(503).send({ status: 'failed', peers: [] });
                return reply.send({ status: 'ok', peers });
            } catch {
                return reply.code(503).send({ status: 'failed', peers: [] });
            }
        });

        this.app.post('/_vh/release/drain', async (request, reply) => {
            if (!this.authorized(request.headers['x-vh-release-token'])) return reply.code(404).send({ error: 'not_found' });
            const body = request.body as Partial<ReleaseDrainNotice> | null;
            if (!body || typeof body.epoch !== 'string' || !/^[A-Za-z0-9._-]{8,128}$/.test(body.epoch)
                || typeof body.toRelease !== 'string' || !/^[0-9a-f]{40}$/.test(body.toRelease)
                || (body.candidateSlot !== 'blue' && body.candidateSlot !== 'green')
                || body.candidateSlot === this.config.slot
                || typeof body.deadline !== 'number' || !Number.isSafeInteger(body.deadline)
                || body.deadline <= Date.now() || body.deadline > Date.now() + 24 * 60 * 60 * 1000) {
                return reply.code(400).send({ error: 'invalid_drain_notice' });
            }
            if (this.drain.epoch && this.drain.epoch !== body.epoch) {
                return reply.code(409).send({ error: 'another_drain_is_active' });
            }
            const notice: ReleaseDrainNotice = {
                epoch: body.epoch,
                fromRelease: this.config.release,
                toRelease: body.toRelease,
                candidateSlot: body.candidateSlot,
                deadline: body.deadline,
                mode: 'make-before-break',
            };
            this.drain = { epoch: notice.epoch, state: 'draining', notice };
            this.io.local.emit('server-draining', notice);
            this.refreshDrainedState();
            return reply.send(this.status());
        });

        this.app.post('/_vh/release/disconnect', async (request, reply) => {
            if (!this.authorized(request.headers['x-vh-release-token'])) return reply.code(404).send({ error: 'not_found' });
            if (this.drain.state === 'accepting') return reply.code(409).send({ error: 'slot_is_not_draining' });
            this.io.local.disconnectSockets(true);
            this.refreshDrainedState();
            return reply.send(this.status());
        });

        // Rollback must be able to make the old slot authoritative again. A
        // Caddy failure after the drain notice but before/after the upstream
        // swap otherwise leaves the restored slot telling every new client to
        // hand over to the failed candidate.
        this.app.post('/_vh/release/cancel', async (request, reply) => {
            if (!this.authorized(request.headers['x-vh-release-token'])) return reply.code(404).send({ error: 'not_found' });
            this.drain = { epoch: null, state: 'accepting', notice: null };
            return reply.send(this.status());
        });
    }

    beginRpc(): () => void {
        this.inFlightRpc += 1;
        let finished = false;
        return () => {
            if (finished) return;
            finished = true;
            this.inFlightRpc = Math.max(0, this.inFlightRpc - 1);
            this.refreshDrainedState();
        };
    }

    private authorized(value: string | string[] | undefined): boolean {
        return safeTokenEqual(Array.isArray(value) ? value[0] : value, this.config.adminToken);
    }

    private async readiness(): Promise<ReleaseReadiness> {
        let database: ReleaseReadiness['database'] = 'failed';
        let redis: ReleaseReadiness['redis'] = 'failed';
        try {
            await db.$queryRaw`SELECT 1`;
            database = 'ready';
        } catch { /* reported below */ }
        try {
            if (await this.redis.ping() === 'PONG') redis = 'ready';
        } catch { /* reported below */ }
        const warmed = Date.now() >= this.adapterReadyAt;
        const socketAdapter: ReleaseReadiness['socketAdapter'] = redis === 'failed'
            ? 'failed'
            : warmed ? 'ready' : 'warming';
        const webAsset = releaseWebAsset(this.staticDir, this.config.release);
        const result: ReleaseReadiness = {
            status: database === 'ready' && redis === 'ready' && socketAdapter === 'ready' && webAsset ? 'ready' : 'not-ready',
            release: this.config.release,
            slot: this.config.slot,
            database,
            redis,
            socketAdapter,
            webAsset,
        };
        releaseSlotReadyGauge.set({ slot: this.config.slot, release: this.config.release }, result.status === 'ready' ? 1 : 0);
        return result;
    }

    private status() {
        const localSockets = this.io.of('/').sockets.size;
        const labels = { slot: this.config.slot, release: this.config.release };
        releaseDrainingGauge.set(labels, this.drain.state === 'accepting' ? 0 : 1);
        releaseLocalConnectionsGauge.set(labels, localSockets);
        releaseInflightHttpGauge.set(labels, this.inFlightHttp);
        releaseInflightRpcGauge.set(labels, this.inFlightRpc);
        return {
            epoch: this.drain.epoch,
            state: this.drain.state,
            release: this.config.release,
            slot: this.config.slot,
            localSockets,
            inFlightHttp: this.inFlightHttp,
            inFlightRpc: this.inFlightRpc,
            deadline: this.drain.notice?.deadline ?? null,
        };
    }

    private refreshDrainedState(): void {
        if (this.drain.state !== 'draining') return;
        if (this.io.of('/').sockets.size === 0 && this.inFlightHttp === 0 && this.inFlightRpc === 0) {
            this.drain.state = 'drained';
        }
    }
}
