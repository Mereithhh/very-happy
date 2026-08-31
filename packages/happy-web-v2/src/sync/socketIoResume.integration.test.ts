import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';

/**
 * Pins the socket.io-client 4.8.x behaviours the resume design relies on
 * (spec 2026-08-web-resume-sync §B, review r1/r2/r3). Real server, real
 * client, short ping cycle. If a socket.io upgrade changes any of these,
 * apiSocket.checkLiveness is wrong and this file says so before production.
 */

const PING_INTERVAL = 100;
const PING_TIMEOUT = 200;

describe('socket.io semantics behind the resume liveness probe', () => {
    let http: HttpServer;
    let io: Server;
    let url = '';
    const clients: ClientSocket[] = [];
    const serverSockets: any[] = [];

    beforeEach(async () => {
        http = createServer();
        io = new Server(http, {
            pingInterval: PING_INTERVAL,
            pingTimeout: PING_TIMEOUT,
            transports: ['websocket'],
            connectionStateRecovery: { maxDisconnectionDuration: 2_000, skipMiddlewares: true },
        });
        io.on('connection', (socket) => {
            serverSockets.push(socket);
            // Mirror of packages/happy-server/sources/app/api/socket/pingHandler.ts:
            // the FIRST argument is the ack callback.
            socket.on('ping', async (callback: (r: unknown) => void) => {
                try { callback({}); } catch { /* swallowed like the real handler */ }
            });
            socket.on('slow', () => { /* never acks */ });
        });
        await new Promise<void>((resolve) => http.listen(0, () => resolve()));
        const address = http.address();
        url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        for (const c of clients.splice(0)) c.disconnect();
        await io.close();
        await new Promise<void>((resolve) => http.close(() => resolve()));
        serverSockets.length = 0;
    });

    function client(opts: Record<string, unknown> = {}) {
        const c = ioc(url, {
            transports: ['websocket'],
            reconnection: true,
            reconnectionDelay: 1_000,
            reconnectionDelayMax: 1_000,
            ...opts,
        });
        clients.push(c);
        return c;
    }

    const onceConnected = (c: ClientSocket) => new Promise<void>((resolve) => {
        if (c.connected) resolve(); else c.once('connect', () => resolve());
    });
    const onceDisconnected = (c: ClientSocket) => new Promise<string>((resolve) => c.once('disconnect', (reason) => resolve(reason)));

    it('a payload-less `ping` is acked with {}; a payload shifts the callback and gets no ack', async () => {
        const c = client();
        await onceConnected(c);
        await expect(c.timeout(1_000).emitWithAck('ping')).resolves.toEqual({});
        await expect(c.timeout(300).emitWithAck('ping', { sentAt: 1 })).rejects.toThrow(/timed out/);
    });

    it('after the ping deadline passed (frozen page), ONE emit closes the socket within a single microtask', async () => {
        const c = client();
        await onceConnected(c);
        // Let a real ping cycle establish _pingTimeoutTime, then jump the clock
        // past pingInterval + pingTimeout the way a frozen page experiences it.
        await new Promise((r) => setTimeout(r, PING_INTERVAL * 2));
        const realNow = Date.now();
        const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow + 60_000);
        expect(c.connected).toBe(true);
        c.emit('app-state', { state: 'active' });
        // engine.io-client schedules the close with its `nextTick`: in the
        // BROWSER build that is `Promise.resolve().then(cb)` (one microtask —
        // what apiSocket.checkLiveness awaits); the node build we run here
        // uses `process.nextTick`. Wait one tick of the node flavour and pin
        // the browser flavour by source text below.
        await new Promise<void>((resolve) => process.nextTick(resolve));
        expect(c.connected).toBe(false);
        spy.mockRestore();
        // socket.io reconnects on its own — we must NOT call io.open() ourselves.
        await onceConnected(c);
        expect(c.connected).toBe(true);
    });

    it('browser build of engine.io-client closes an expired socket on a Promise microtask (source lock)', async () => {
        const { readFileSync } = await import('node:fs');
        const { createRequire } = await import('node:module');
        const req = createRequire(import.meta.url);
        const pkg = req.resolve('engine.io-client/package.json');
        const globals = readFileSync(pkg.replace(/package\.json$/, 'build/esm/globals.js'), 'utf8');
        expect(globals).toContain('return (cb) => Promise.resolve().then(cb);');
        const engine = readFileSync(pkg.replace(/package\.json$/, 'build/esm/socket.js'), 'utf8');
        expect(engine).toMatch(/_hasPingExpired\(\)[\s\S]*nextTick\(\(\) => \{\s*this\._onClose\("ping timeout"\);/);
    });

    it('`disconnect(); connect()` during the reconnect backoff opens immediately and clears _reconnecting', async () => {
        const c = client();
        await onceConnected(c);
        const dropped = onceDisconnected(c);
        serverSockets[0].conn.close(); // transport close → client backs off 1s before retrying
        expect(await dropped).toBe('transport close');
        expect((c.io as any)._reconnecting).toBe(true);
        const t0 = Date.now();
        c.disconnect();
        c.connect();
        await onceConnected(c);
        expect(Date.now() - t0).toBeLessThan(800);
        expect((c.io as any)._reconnecting).toBe(false);
        // …and the automatic reconnection machinery is still armed afterwards.
        const dropped2 = onceDisconnected(c);
        serverSockets[serverSockets.length - 1].conn.close();
        await dropped2;
        await onceConnected(c);
    });

    it('a forced disconnect rejects in-flight acks but keeps buffered (unsent) packets, which flush after connect', async () => {
        const c = client();
        await onceConnected(c);
        const inFlight = c.timeout(5_000).emitWithAck('slow');
        c.disconnect();
        await expect(inFlight).rejects.toThrow(/disconnected/);
        const buffered = c.emitWithAck('ping'); // not connected → sendBuffer
        c.connect();
        await expect(buffered).resolves.toEqual({});
    });

    it('a client-initiated disconnect never recovers (recovered=false), a transport drop within the window does', async () => {
        const c = client({ reconnectionDelay: 50, reconnectionDelayMax: 50 });
        await onceConnected(c);
        c.disconnect();
        c.connect();
        await onceConnected(c);
        expect(c.recovered).toBe(false);
        // Recovery needs an offset: the client only has one after it received
        // at least one event on this session.
        const got = new Promise<void>((resolve) => c.once('tick', () => resolve()));
        serverSockets[serverSockets.length - 1].emit('tick', 1);
        await got;
        const dropped = onceDisconnected(c);
        serverSockets[serverSockets.length - 1].conn.close();
        await dropped;
        await onceConnected(c);
        expect(c.recovered).toBe(true);
    });
});
