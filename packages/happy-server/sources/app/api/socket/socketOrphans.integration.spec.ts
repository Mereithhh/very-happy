/**
 * B-543: the double-CONNECT orphan over a REAL socket.io server + client.
 *
 * Reproduces the 2026-10-11 incident mechanism: a slow server accept (auth,
 * limiter, recovery queue) and a client that calls `connect()` again while its
 * first CONNECT is unanswered put two CONNECTs on ONE engine connection. The
 * server builds two Sockets; inbound packets (acks) route to the newest, the
 * older one stays in the RPC room, and `emitWithAck` on it times out.
 *
 * `evictOrphansOf` / `sweepOrphans` reach into socket.io 4.8 private fields;
 * this file is what pins them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { Server, type Socket } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { evictOrphansOf, isLocalOrphan, sweepOrphans, type OrphanEviction } from './socketOrphans';
import { rpcHandler } from './rpcHandler';

const ACCEPT_DELAY_MS = 400;
const SECOND_CONNECT_AT_MS = 150;
const ROOM = 'rpc:user:sess:conversation-rewind';

interface Harness {
    ioServer: Server;
    client: ClientSocket;
    connections: Socket[];
    disconnects: Map<string, string[]>;
    evictions: OrphanEviction[];
    clientDisconnects: string[];
    clientConnects: number;
}

let httpServer: HttpServer | null = null;
let ioServer: Server | null = null;
let client: ClientSocket | null = null;

afterEach(async () => {
    client?.close();
    await ioServer?.close();
    await new Promise<void>((resolve) => (httpServer ? httpServer.close(() => resolve()) : resolve()));
    httpServer = null;
    ioServer = null;
    client = null;
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(check: () => boolean, timeoutMs = 3000) {
    const started = Date.now();
    while (!check()) {
        if (Date.now() - started > timeoutMs) throw new Error('condition not reached');
        await sleep(10);
    }
}

async function doubleConnect(options: {
    evict: boolean;
    /** Attach the production rpcHandler (room join + rpc-call routing). */
    withRpcHandler?: boolean;
    /** Client delays its rpc-request ack (to land after the second CONNECT). */
    ackDelayMs?: number;
    onFirstConnection?: (socket: Socket) => void;
}): Promise<Harness> {
    httpServer = createServer();
    ioServer = new Server(httpServer);
    await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

    const h: Harness = {
        ioServer,
        client: null as unknown as ClientSocket,
        connections: [],
        disconnects: new Map(),
        evictions: [],
        clientDisconnects: [],
        clientConnects: 0,
    };

    // Slow accept, like auth + connection limiter + recovery under a reconnect storm.
    ioServer.use((_socket, next) => setTimeout(next, ACCEPT_DELAY_MS));
    ioServer.on('connection', (socket) => {
        h.connections.push(socket);
        // Stand-in for socket.ts bookkeeping (eventRouter, connection count,
        // limiter lease): it must run exactly once per socket.
        socket.on('disconnect', (reason) => {
            const list = h.disconnects.get(socket.id) ?? [];
            list.push(reason);
            h.disconnects.set(socket.id, list);
        });
        if (options.withRpcHandler) {
            rpcHandler('user', socket, ioServer!, socket.handshake.auth?.caller ? undefined : 'sess');
        } else {
            socket.on('rpc-register', (method: string) => { void socket.join(`rpc:user:${method}`); });
        }
        socket.on('ping-server', (ack: (value: string) => void) => ack(socket.id));
        if (h.connections.length === 1) options.onFirstConnection?.(socket);
        if (options.evict) evictOrphansOf(socket, (eviction) => h.evictions.push(eviction));
    });

    client = connect(url, { reconnection: false, transports: ['websocket'], forceNew: true });
    h.client = client;
    client.on('connect', () => {
        h.clientConnects++;
        client!.emit('rpc-register', options.withRpcHandler ? { method: 'sess:conversation-rewind' } : 'sess:conversation-rewind');
    });
    client.on('disconnect', (reason) => h.clientDisconnects.push(reason));
    client.on('rpc-request', (_data: unknown, ack: (value: string) => void) => {
        if (options.ackDelayMs) setTimeout(() => ack('done'), options.ackDelayMs);
        else ack('done');
    });
    // The old CLI startSmartReconnect: connect() again while CONNECT #1 is pending.
    setTimeout(() => client!.connect(), SECOND_CONNECT_AT_MS);

    await until(() => h.connections.length === 2 && h.clientConnects === 2);
    // let the second rpc-register land
    await sleep(100);
    return h;
}

describe('double CONNECT on one engine connection (B-543)', () => {
    it('baseline without eviction: the orphan stays in the RPC room and its ack times out', async () => {
        const h = await doubleConnect({ evict: false });
        expect(h.ioServer.engine.clientsCount).toBe(1);
        const room = await h.ioServer.in(ROOM).fetchSockets();
        expect(room).toHaveLength(2);
        const [orphan] = h.connections;
        expect(isLocalOrphan(orphan)).toBe(true);
        expect(isLocalOrphan(h.connections[1])).toBe(false);
        // The client really runs the handler; only the ack is lost.
        await expect(orphan.timeout(500).emitWithAck('rpc-request', {})).rejects.toThrow('operation has timed out');
    });

    it('evicts the orphan on connection: room = 1, RPC succeeds, client never sees a disconnect', async () => {
        const h = await doubleConnect({ evict: true });
        const [orphan, live] = h.connections;

        expect(h.evictions).toHaveLength(1);
        expect(h.evictions[0].orphan).toBe(orphan);
        expect(h.evictions[0].live).toBe(live);
        expect(h.evictions[0].trigger).toBe('connection');

        const room = await h.ioServer.in(ROOM).fetchSockets();
        expect(room.map((s) => s.id)).toEqual([live.id]);
        expect(h.ioServer.of('/').sockets.size).toBe(1);
        expect(orphan.rooms.size).toBe(0);
        expect(orphan.connected).toBe(false);

        // Server → client RPC through the room target succeeds.
        await expect(room[0].timeout(1000).emitWithAck('rpc-request', {})).resolves.toBe('done');
        // Client → server still routes to the live socket.
        await expect(h.client.timeout(1000).emitWithAck('ping-server')).resolves.toBe(live.id);

        // No DISCONNECT packet went to the wire.
        await sleep(100);
        expect(h.clientDisconnects).toEqual([]);
        expect(h.client.connected).toBe(true);

        // Disconnect bookkeeping ran exactly once, for the orphan only.
        expect(h.disconnects.get(orphan.id)).toEqual(['server namespace disconnect']);
        expect(h.disconnects.has(live.id)).toBe(false);

        // The live socket keeps its engine-client mapping.
        const internals = (live as unknown as { client: { nsps: Map<string, Socket>; sockets: Map<string, Socket> } }).client;
        expect(internals.nsps.get('/')).toBe(live);
        expect([...internals.sockets.keys()]).toEqual([live.id]);

        // A later real disconnect runs the live socket's bookkeeping once and
        // does not re-run the orphan's.
        h.client.disconnect();
        await until(() => h.disconnects.has(live.id));
        expect(h.disconnects.get(live.id)).toHaveLength(1);
        expect(h.disconnects.get(orphan.id)).toHaveLength(1);
    });

    it('an RPC in flight on the orphan when the second CONNECT lands still gets its answer', async () => {
        let inFlight: Promise<unknown> | null = null;
        const h = await doubleConnect({
            evict: true,
            ackDelayMs: ACCEPT_DELAY_MS + 200,
            onFirstConnection: (socket) => {
                inFlight = socket.timeout(3000).emitWithAck('rpc-request', {});
            },
        });
        expect(h.evictions[0].transferredAcks).toBe(1);
        await expect(inFlight).resolves.toBe('done');
    });

    it('the sweeper evicts an orphan that slipped past connection-time eviction', async () => {
        const h = await doubleConnect({ evict: false });
        const [orphan, live] = h.connections;
        const evictions: OrphanEviction[] = [];
        expect(sweepOrphans(h.ioServer.of('/'), (e) => evictions.push(e))).toBe(1);
        expect(evictions[0].orphan).toBe(orphan);
        expect(evictions[0].trigger).toBe('sweep');
        expect(sweepOrphans(h.ioServer.of('/'))).toBe(0);
        const room = await h.ioServer.in(ROOM).fetchSockets();
        expect(room.map((s) => s.id)).toEqual([live.id]);
        await expect(room[0].timeout(1000).emitWithAck('rpc-request', {})).resolves.toBe('done');
        await sleep(100);
        expect(h.clientDisconnects).toEqual([]);
        expect(h.disconnects.get(orphan.id)).toEqual(['server namespace disconnect']);
    });

    it('rpcHandler routes a real rpc-call to the live socket even before eviction', async () => {
        const h = await doubleConnect({ evict: false, withRpcHandler: true });
        expect(await h.ioServer.in(ROOM).fetchSockets()).toHaveLength(2);
        const url = `http://127.0.0.1:${(httpServer!.address() as AddressInfo).port}`;
        const caller = connect(url, { reconnection: false, transports: ['websocket'], forceNew: true, auth: { caller: true } });
        try {
            await new Promise<void>((resolve) => caller.on('connect', () => resolve()));
            await expect(caller.timeout(3000).emitWithAck('rpc-call', { method: 'sess:conversation-rewind', params: '{}' }))
                .resolves.toEqual({ ok: true, result: 'done' });
        } finally {
            caller.close();
        }
    });

    it('a normal single connection is left alone', async () => {
        httpServer = createServer();
        ioServer = new Server(httpServer);
        await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
        const evictions: OrphanEviction[] = [];
        ioServer.on('connection', (socket) => evictOrphansOf(socket, (e) => evictions.push(e)));
        client = connect(url, { reconnection: false, transports: ['websocket'], forceNew: true });
        await new Promise<void>((resolve) => client!.on('connect', () => resolve()));
        expect(evictions).toEqual([]);
        expect(sweepOrphans(ioServer.of('/'))).toBe(0);
    });
});

describe('socket.ts wiring (B-543)', () => {
    // Source pin, verified with scripts/dev/mutation-check.mjs: startSocket
    // needs Redis/DB, so the wiring is asserted on the source.
    const source = readFileSync(join(__dirname, '..', 'socket.ts'), 'utf8');

    it('evicts orphans first thing on every connection, before connection counting', () => {
        expect(source).toMatch(/io\.on\("connection", \(socket\) => \{\n\s+evictOrphansOf\(socket, recordOrphanEviction\);/);
    });

    it('sweeps local orphans on an interval and records each eviction', () => {
        expect(source).toMatch(/sweepOrphans\(io\.of\('\/'\), recordOrphanEviction\);\n[\s\S]{0,200}\}, ORPHAN_SWEEP_INTERVAL_MS\);/);
        expect(source).toMatch(/socketOrphansEvictedCounter\.inc\(\{ trigger: eviction\.trigger/);
    });
});
