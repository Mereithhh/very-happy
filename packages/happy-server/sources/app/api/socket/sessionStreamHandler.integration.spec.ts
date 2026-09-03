/**
 * B-309: the relay over a REAL socket.io server and client pair.
 *
 * The unit spec pins the handler's decisions against fakes. This one pins the
 * things fakes cannot: that the user-scoped room name actually matches what
 * clients join, that the rebuilt event survives socket.io serialization with
 * every field a client decodes intact, and that a second account's client
 * never sees the frame.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionStreamHandler } from './sessionStreamHandler';

let httpServer: HttpServer;
let ioServer: Server;
let url: string;
const clients: ClientSocket[] = [];

beforeEach(async () => {
    httpServer = createServer();
    ioServer = new Server(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

    ioServer.on('connection', (socket) => {
        // Stand in for the real auth middleware: role and identity come from
        // handshake auth here, from the verified token in production.
        const { userId, role, sessionId } = socket.handshake.auth as {
            userId: string; role: string; sessionId?: string;
        };
        if (role === 'user-scoped') {
            void socket.join(`user:${userId}:user-scoped`);
            return;
        }
        sessionStreamHandler(userId, socket, ioServer, {
            connectionType: 'session-scoped',
            sessionId,
        });
    });
});

afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await ioServer.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

function client(auth: Record<string, unknown>): Promise<ClientSocket> {
    const socket = connect(url, { auth, transports: ['websocket'], forceNew: true });
    clients.push(socket);
    return new Promise((resolve) => socket.on('connect', () => resolve(socket)));
}

function nextFrame(socket: ClientSocket, timeoutMs = 1500): Promise<any> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no session-stream frame arrived')), timeoutMs);
        socket.once('session-stream', (data: unknown) => {
            clearTimeout(timer);
            resolve(data);
        });
    });
}

describe('session-stream over a real socket.io pair', () => {
    it('delivers a session process frame to the account’s web clients, fields intact', async () => {
        const web = await client({ userId: 'u1', role: 'user-scoped' });
        const session = await client({ userId: 'u1', role: 'session-scoped', sessionId: 's1' });

        const received = nextFrame(web);
        session.emit('session-stream', { payload: 'cipher-b64', enc: true });

        // `enc` dropping in the rebuild is the terminal-output bug class: the
        // client would then treat ciphertext as plaintext.
        await expect(received).resolves.toEqual({ sessionId: 's1', payload: 'cipher-b64', enc: true });
    });

    it('does not deliver to another account', async () => {
        const other = await client({ userId: 'u2', role: 'user-scoped' });
        const mine = await client({ userId: 'u1', role: 'user-scoped' });
        const session = await client({ userId: 'u1', role: 'session-scoped', sessionId: 's1' });

        const leaked = nextFrame(other, 400);
        const delivered = nextFrame(mine);
        session.emit('session-stream', { payload: 'p', enc: true });

        await expect(delivered).resolves.toMatchObject({ sessionId: 's1' });
        await expect(leaked).rejects.toThrow('no session-stream frame arrived');
    });

    it('reaches every web client the account has open', async () => {
        const first = await client({ userId: 'u1', role: 'user-scoped' });
        const second = await client({ userId: 'u1', role: 'user-scoped' });
        const session = await client({ userId: 'u1', role: 'session-scoped', sessionId: 's1' });

        const both = Promise.all([nextFrame(first), nextFrame(second)]);
        session.emit('session-stream', { payload: 'p', enc: true });

        const [a, b] = await both;
        expect(a).toEqual(b);
    });
});

describe('socket.ts wiring', () => {
    it('registers the handler alongside the other relays', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const source = readFileSync(join(__dirname, '..', 'socket.ts'), 'utf8');
        // Without this line the relay exists but nothing ever calls it, and
        // the failure is silent: frames simply vanish at the server.
        expect(source).toContain('sessionStreamHandler(userId, socket, io, connection, sessionStreamRateLimiter)');
    });
});
