/**
 * B-811 (B-807 spec §4.6, §9.1-9): cross-slot. Two socket.io servers ("blue"
 * and "green") share one database and one Redis stream through the production
 * bounded streams adapter, like vh-sg's two slots. The web client says hello
 * on blue; every write commits and emits on green. Snapshot ∪ pushes relayed
 * through Redis must still be gap-free.
 *
 * Needs a real Redis: VH_TEST_REDIS_URL=redis://127.0.0.1:6379 (skipped
 * otherwise, like boundedStreamsAdapter.integration.spec.ts). The database is
 * PGlite unless VH_TEST_DATABASE_URL is set.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Redis as RedisClient } from 'ioredis';
import type * as Harness from '../testing/sessionSyncHarness';

const redisUrl = process.env.VH_TEST_REDIS_URL;

describe.runIf(!!redisUrl)('sync-hello across slots (real Redis)', () => {
    let harness: typeof Harness;
    let database: Harness.SyncTestDatabase;
    let blue: Harness.SyncTestServer;
    let green: Harness.SyncTestServer;
    let fixture: Harness.SharedSessionFixture;
    let writers: Harness.Writers;
    let db: typeof import('@/storage/db').db;
    const redisClients: RedisClient[] = [];
    const stream = `vh:test:b811:${randomUUID()}`;

    async function adapterFor(slot: string) {
        const { Redis } = await import('ioredis');
        const { decode } = await import('@msgpack/msgpack');
        const { createBoundedStreamsAdapter, defaultRecoveryLimits } = await import('./boundedStreamsAdapter');
        const connection = async (role: string) => {
            const client = new Redis(redisUrl!, { lazyConnect: true, connectionName: `b811-${slot}-${role}`, maxRetriesPerRequest: null });
            await client.connect();
            redisClients.push(client);
            return client;
        };
        const connections = { publish: await connection('publish'), poll: await connection('poll'), restore: await connection('restore') };
        return createBoundedStreamsAdapter(connections, {
            streamName: stream,
            sessionKeyPrefix: `${stream}:session:`,
            maxLen: 20_000,
            readCount: 100,
            heartbeatInterval: 200,
            heartbeatTimeout: 1_000,
            limits: defaultRecoveryLimits(30_000),
            decodeSession: (raw: string) => decode(Buffer.from(raw, 'base64')),
        });
    }

    beforeAll(async () => {
        harness = await import('../testing/sessionSyncHarness');
        database = await harness.prepareSyncTestDatabase('session-sync-cross-slot');
        ({ db } = await import('@/storage/db'));
        const blueAdapter = await adapterFor('blue');
        const greenAdapter = await adapterFor('green');
        blue = await harness.startSyncServer({ joinMode: 'lazy', routeEvents: false, adapter: (io) => { io.adapter(blueAdapter as any); } });
        green = await harness.startSyncServer({ joinMode: 'prod', routeEvents: true, adapter: (io) => { io.adapter(greenAdapter as any); } });
        await harness.sleep(400);
        fixture = await harness.createSharedSession('xslot');
        writers = await harness.createWriters(green.url, fixture);
    }, 120_000);

    afterAll(async () => {
        await writers?.close();
        await blue?.close();
        await green?.close();
        if (redisClients[0]) await redisClients[0].del(stream).catch(() => {});
        await Promise.all(redisClients.map((client) => client.quit().catch(() => client.disconnect())));
        await db?.$disconnect();
        database?.cleanup();
    });

    it('hello on blue while green writes: snapshot ∪ relayed pushes = every committed seq, 60 rounds', async () => {
        for (let round = 0; round < 60; round += 1) {
            const random = harness.seededRandom(811_700 + round);
            const userId = round % 4 === 3 ? fixture.granteeId : fixture.ownerId;
            const head = await harness.sessionHead(fixture.sessionId);
            const afterSeq = Math.max(0, head - Math.floor(random() * 3));
            const writing = Promise.all(Array.from({ length: 1 + Math.floor(random() * 4) }, async () => {
                await harness.sleep(Math.floor(random() * 25));
                await writers.write(harness.WRITER_KINDS[Math.floor(random() * harness.WRITER_KINDS.length)]);
            }));
            await harness.sleep(Math.floor(random() * 10));
            const client = await harness.connectClient(blue.url, { userId });
            try {
                const ack = await harness.emitWithAck(client.socket, 'sync-hello', { v: 1, subs: [{ sid: fixture.sessionId, afterSeq }] });
                await writing;
                expect(ack.ok).toBe(true);
                const result = ack.results[0];
                expect(result.ok).toBe(true);
                const expected = await harness.committedSeqs(fixture.sessionId, afterSeq);
                const seqs: number[] = result.messages.map((m: { seq: number }) => m.seq);
                const seen = () => [...new Set([...seqs, ...(client.pushes.get(fixture.sessionId) ?? [])])].filter((s) => s > afterSeq).sort((a, b) => a - b);
                for (let wait = 0; wait < 300 && seen().length < expected.length; wait += 1) await harness.sleep(10);
                expect(seen(), `round ${round}`).toEqual(expected);
            } finally {
                client.socket.close();
            }
        }
    }, 180_000);

    it('a write on green is pushed to a blue socket that only said hello (relay really crosses slots)', async () => {
        const client = await harness.connectClient(blue.url, { userId: fixture.ownerId });
        try {
            const head = await harness.sessionHead(fixture.sessionId);
            const ack = await harness.emitWithAck(client.socket, 'sync-hello', { v: 1, subs: [{ sid: fixture.sessionId, afterSeq: head }] });
            expect(ack.results[0]).toMatchObject({ ok: true, headSeq: head, messages: [] });
            await writers.write('v3-post');
            for (let wait = 0; wait < 300 && !(client.pushes.get(fixture.sessionId) ?? []).includes(head + 1); wait += 1) await harness.sleep(10);
            expect(client.pushes.get(fixture.sessionId)).toEqual([head + 1]);
        } finally {
            client.socket.close();
        }
    });
});
