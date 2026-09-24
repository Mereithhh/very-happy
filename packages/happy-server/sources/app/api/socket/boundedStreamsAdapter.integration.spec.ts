import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { Redis } from 'ioredis';
import { decode as msgpackDecode } from '@msgpack/msgpack';
import { createBoundedStreamsAdapter, defaultRecoveryLimits, type RecoveryLimits } from './boundedStreamsAdapter';

// B-494 against a real Redis (set VH_TEST_REDIS_URL, e.g. redis://127.0.0.1:6379).
// Two "slots" share one stream, like blue/green in production.

const redisUrl = process.env.VH_TEST_REDIS_URL;
const WINDOW = 30_000;

describe.runIf(!!redisUrl)('bounded streams adapter (real Redis)', () => {
    const redisClients: Redis[] = [];
    const servers: Server[] = [];
    const https: HttpServer[] = [];
    const ports: number[] = [];
    const stream = `vh:test:b494:${randomUUID()}`;
    const limits: RecoveryLimits = { ...defaultRecoveryLimits(WINDOW), maxOffsetAgeMs: 1_500 };

    const connection = async (name: string) => {
        const client = new Redis(redisUrl!, { lazyConnect: true, connectionName: name });
        await client.connect();
        redisClients.push(client);
        return client;
    };

    beforeAll(async () => {
        for (const slot of ['blue', 'green']) {
            const connections = {
                publish: await connection(`b494-${slot}-publish`),
                poll: await connection(`b494-${slot}-poll`),
                restore: await connection(`b494-${slot}-restore`),
            };
            const http = createServer();
            const io = new Server(http, { connectionStateRecovery: { maxDisconnectionDuration: WINDOW, skipMiddlewares: true } });
            io.adapter(createBoundedStreamsAdapter(connections, {
                streamName: stream,
                sessionKeyPrefix: `${stream}:session:`,
                maxLen: 20_000,
                readCount: 100,
                heartbeatInterval: 200,
                heartbeatTimeout: 1_000,
                limits,
                decodeSession: (raw) => msgpackDecode(Buffer.from(raw, 'base64')),
            }));
            io.on('connection', (socket) => { socket.join('room:a'); });
            await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
            servers.push(io);
            https.push(http);
            ports.push((http.address() as AddressInfo).port);
        }
        await new Promise((r) => setTimeout(r, 400));
    });

    afterAll(async () => {
        await Promise.all(servers.map((io) => new Promise<void>((resolve) => io.close(() => resolve()))));
        await Promise.all(https.map((h) => h.listening ? new Promise<void>((r) => h.close(() => r())) : Promise.resolve()));
        const cleanup = redisClients[0];
        if (cleanup) await cleanup.del(stream).catch(() => {});
        await Promise.all(redisClients.map((c) => c.quit().catch(() => c.disconnect())));
    });

    const connectClient = (port: number): Promise<{ socket: ClientSocket; received: string[] }> => new Promise((resolve, reject) => {
        const received: string[] = [];
        const socket = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false });
        socket.on('evt', (v: string) => received.push(v));
        socket.once('connect', () => resolve({ socket, received }));
        socket.once('connect_error', reject);
    });

    const reconnect = (socket: ClientSocket, port: number) => new Promise<void>((resolve, reject) => {
        // Move the same client (same pid/offset) to the other slot, as a Caddy
        // switch does, and reconnect.
        (socket.io as any).uri = `http://127.0.0.1:${port}`;
        (socket.io as any).engine = undefined;
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
        socket.connect();
    });

    const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

    // A transport drop (what a Caddy reload does) — unlike socket.disconnect(),
    // this is a recoverable reason, so the server persists the session.
    const dropTransport = async (socket: ClientSocket) => {
        const gone = new Promise((r) => socket.once('disconnect', r));
        (socket.io as any).engine.close();
        await gone;
        await settle(50);
    };

    it('recovers missed events across slots within the window', async () => {
        const { socket, received } = await connectClient(ports[0]);
        servers[1].to('room:a').emit('evt', 'first');
        await settle();
        expect(received).toEqual(['first']);
        await dropTransport(socket);
        servers[1].to('room:a').emit('evt', 'missed');
        await settle();
        await reconnect(socket, ports[1]);
        await settle();
        expect(socket.recovered).toBe(true);
        expect(received).toEqual(['first', 'missed']);
        socket.disconnect();
    });

    it('falls back to recovered=false when the offset is older than the recovery bound', async () => {
        const { socket, received } = await connectClient(ports[0]);
        servers[1].to('room:a').emit('evt', 'old');
        await settle();
        expect(received).toEqual(['old']);
        await settle(limits.maxOffsetAgeMs + 200);
        await dropTransport(socket);
        await reconnect(socket, ports[1]);
        expect(socket.recovered).toBe(false);
        socket.disconnect();
    });

    it('keeps XADD, XREAD and XRANGE on separate named connections', async () => {
        const list = String(await redisClients[0].client('LIST'));
        const lastCmd = (name: string) => /cmd=([^ ]+)/.exec(list.split('\n').find((l) => l.includes(`name=${name} `)) ?? '')?.[1];
        // poll connection only ever runs XREAD; restore only XRANGE.
        expect(lastCmd('b494-blue-poll')).toBe('xread');
        expect(lastCmd('b494-green-restore')).toBe('xrange');
        expect(await redisClients[0].xlen(stream)).toBeGreaterThan(0);
    });
});
