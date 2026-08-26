import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import { Redis } from 'ioredis';
import { createAdapter } from '@socket.io/redis-streams-adapter';

const redisUrl = process.env.VH_TEST_REDIS_URL;

describe.runIf(!!redisUrl)('release cross-slot Redis canary', () => {
    const clients: Redis[] = [];
    const servers: Server[] = [];
    const httpServers: HttpServer[] = [];

    beforeAll(async () => {
        const sharedStream = `vh:test:${randomUUID()}`;
        for (const slot of ['blue', 'green'] as const) {
            const client = new Redis(redisUrl!, { lazyConnect: true });
            await client.connect();
            clients.push(client);
            const http = createServer();
            const io = new Server(http);
            io.adapter(createAdapter(client, {
                streamName: sharedStream,
                heartbeatInterval: 100,
                heartbeatTimeout: 500,
            }));
            io.on('vh-release-canary', (probe: { nonce: string }, callback: (value: unknown) => void) => {
                callback({ nonce: probe.nonce, slot });
            });
            servers.push(io);
            httpServers.push(http);
            await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
        }
        await new Promise((resolve) => setTimeout(resolve, 350));
    });

    afterAll(async () => {
        await Promise.all(servers.map((io) => new Promise<void>((resolve) => io.close(() => resolve()))));
        await Promise.all(httpServers.map((server) => server.listening
            ? new Promise<void>((resolve) => server.close(() => resolve()))
            : Promise.resolve()));
        await Promise.all(clients.map((client) => client.quit()));
    });

    it('receives an acknowledged server-side event in both directions', async () => {
        const blue = await servers[0].serverSideEmitWithAck('vh-release-canary', { nonce: 'blue-probe' });
        const green = await servers[1].serverSideEmitWithAck('vh-release-canary', { nonce: 'green-probe' });
        expect(blue).toContainEqual({ nonce: 'blue-probe', slot: 'green' });
        expect(green).toContainEqual({ nonce: 'green-probe', slot: 'blue' });
    });
});
