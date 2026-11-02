/**
 * B-864 over a REAL socket.io server + clients: the guard socket.ts installs
 * (middleware `admit` + post-join `afterJoin`) keeps one agent per session room.
 * Reproduces the Xu CHEN 11-02 shape — two wrappers on one session, both
 * receiving the user's message — and shows the older one stops receiving.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { createSessionAgentGuard, SESSION_SUPERSEDED_ERROR, type SupersededOutcome } from './sessionAgentExclusivity';

const ROOM = (userId: string, sessionId: string) => `user:${userId}:session:${sessionId}`;
let httpServer: HttpServer | null = null;
let ioServer: Server | null = null;
const clients: ClientSocket[] = [];

afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await ioServer?.close();
    await new Promise<void>((resolve) => (httpServer ? httpServer.close(() => resolve()) : resolve()));
    httpServer = null;
    ioServer = null;
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function start(opts: { admitDelayMs?: number } = {}) {
    httpServer = createServer();
    ioServer = new Server(httpServer);
    const io = ioServer;
    const records: Array<{ stale: string; outcome: SupersededOutcome }> = [];
    const guard = createSessionAgentGuard({
        roomOf: ROOM,
        fetchRoom: (room) => io.in(room).timeout(1_000).fetchSockets(),
        record: ({ stale, outcome }) => records.push({ stale: stale.id, outcome }),
    });
    // Same order as socket.ts: auth data → admit → (connection) join → afterJoin.
    io.use(async (socket, next) => {
        socket.data.userId = 'u1';
        socket.data.clientType = 'session-scoped';
        socket.data.sessionId = 's1';
        socket.data.happyClient = socket.handshake.auth.happyClient;
        if (opts.admitDelayMs) await sleep(opts.admitDelayMs);
        if (!await guard.admit(socket, 'u1', 's1')) return next(new Error(SESSION_SUPERSEDED_ERROR));
        next();
    });
    io.on('connection', (socket) => {
        socket.join(ROOM('u1', 's1'));
        guard.afterJoin(socket, 'u1', 's1');
    });
    await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(httpServer!.address() as AddressInfo).port}`;
    const deliver = (text: string) => io.to(ROOM('u1', 's1')).emit('update', text);
    return { io, url, records, deliver };
}

function wrapper(url: string, auth: Record<string, unknown>) {
    const client = connect(url, { transports: ['websocket'], reconnection: false, auth: { happyClient: 'cli-coding-session/test', ...auth } });
    clients.push(client);
    const received: string[] = [];
    const superseded: unknown[] = [];
    client.on('update', (text: string) => received.push(text));
    client.on('session-superseded', (notice: unknown) => superseded.push(notice));
    const outcome = new Promise<'connected' | string>((resolve) => {
        client.once('connect', () => resolve('connected'));
        client.once('connect_error', (error) => resolve(error.message));
    });
    return { client, received, superseded, outcome };
}

describe('B-864 one agent connection per session (real socket.io)', () => {
    it('a newer wrapper takes over: the older is told, disconnected and no longer receives messages', async () => {
        const { url, records, deliver } = await start();
        const w1 = wrapper(url, { agentInstance: 'w1', agentStartedAt: 1_000 });
        expect(await w1.outcome).toBe('connected');
        deliver('before');
        await sleep(50);
        expect(w1.received).toEqual(['before']);

        const w2 = wrapper(url, { agentInstance: 'w2', agentStartedAt: 2_000, happyClient: 'cli-coding-session/0.2.196' });
        expect(await w2.outcome).toBe('connected');
        await sleep(100);
        expect(w1.superseded).toEqual([{ sessionId: 's1', by: { startedAt: 2_000, happyClient: 'cli-coding-session/0.2.196' } }]);
        expect(w1.client.connected).toBe(false);

        deliver('the user message');
        await sleep(50);
        expect(w2.received).toEqual(['the user message']);
        expect(w1.received).toEqual(['before']);
        expect(records).toEqual([{ stale: expect.any(String), outcome: 'evicted' }]);

        // The stale process coming back is refused before it joins the room.
        const w1again = wrapper(url, { agentInstance: 'w1', agentStartedAt: 1_000 });
        expect(await w1again.outcome).toBe(SESSION_SUPERSEDED_ERROR);
        deliver('next');
        await sleep(50);
        expect(w1again.received).toEqual([]);
        expect(w2.received).toEqual(['the user message', 'next']);
        expect(w2.client.connected).toBe(true);
    });

    it('the same process (release handover candidate) is never evicted', async () => {
        const { url, deliver } = await start();
        const previous = wrapper(url, { agentInstance: 'same', agentStartedAt: 1_000 });
        expect(await previous.outcome).toBe('connected');
        const candidate = wrapper(url, { agentInstance: 'same', agentStartedAt: 1_000 });
        expect(await candidate.outcome).toBe('connected');
        await sleep(100);
        expect(previous.client.connected).toBe(true);
        expect(previous.superseded).toEqual([]);
        deliver('x');
        await sleep(50);
        expect(candidate.received).toEqual(['x']);
    });

    it('old CLIs: a legacy wrapper is evicted by and refused beside a new one; legacy alone is untouched', async () => {
        const { url } = await start();
        const legacyA = wrapper(url, {});
        const legacyB = wrapper(url, {});
        expect(await legacyA.outcome).toBe('connected');
        expect(await legacyB.outcome).toBe('connected');
        await sleep(100);
        expect(legacyA.client.connected).toBe(true);   // pre-B-864 behaviour among old CLIs

        const modern = wrapper(url, { agentInstance: 'm', agentStartedAt: 5_000 });
        expect(await modern.outcome).toBe('connected');
        await sleep(100);
        expect(legacyA.client.connected).toBe(false);
        expect(legacyB.client.connected).toBe(false);
        const legacyRetry = wrapper(url, {});
        expect(await legacyRetry.outcome).toBe(SESSION_SUPERSEDED_ERROR);
    });

    it('two newcomers racing through the middleware end with only the newest', async () => {
        const { url, deliver } = await start({ admitDelayMs: 150 });
        const older = wrapper(url, { agentInstance: 'a', agentStartedAt: 1_000 });
        const newer = wrapper(url, { agentInstance: 'b', agentStartedAt: 2_000 });
        await Promise.all([older.outcome, newer.outcome]);
        await sleep(300);
        deliver('m');
        await sleep(50);
        expect(newer.client.connected).toBe(true);
        expect(older.client.connected).toBe(false);
        expect(newer.received).toEqual(['m']);
        expect(older.received).toEqual([]);
    });
});
