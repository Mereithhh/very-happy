import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { CONNECT_PENDING_MAX_MS, SocketConnectGuard, connectGuarded, decideConnect } from './socketConnectGuard';

/**
 * B-543 regression. socket.io-client re-sends CONNECT when connect() is called
 * on an open manager whose previous CONNECT is not yet acknowledged; the CLI
 * reconnect loop did exactly that (3 s interval + 1 s timeout) and the server
 * kept an orphan socket that swallowed every RPC ack.
 */

class FakeSocket extends EventEmitter {
    connected = false;
    active = false;
    connectCalls = 0;
    disconnectCalls = 0;
    /** CONNECT packets put on the CURRENT engine connection. */
    connectPacketsOnEngine = 0;
    connect() {
        this.connectCalls++;
        this.active = true;
        this.connectPacketsOnEngine++;
    }
    disconnect() {
        this.disconnectCalls++;
        this.active = false;
        // socket.io-client: disconnect() on a socket that is not connected tears
        // the manager down without emitting 'disconnect'.
        this.connectPacketsOnEngine = 0;
    }
}

describe('decideConnect', () => {
    it('never connects a connected socket', () => {
        expect(decideConnect({ connected: true, pendingSince: null, now: 0 })).toBe('skip-connected');
        expect(decideConnect({ connected: true, pendingSince: 0, now: 99_999 })).toBe('skip-connected');
    });
    it('connects when nothing is pending', () => {
        expect(decideConnect({ connected: false, pendingSince: null, now: 5 })).toBe('connect');
    });
    it('does not resend while a CONNECT is pending', () => {
        expect(decideConnect({ connected: false, pendingSince: 1000, now: 1000 + CONNECT_PENDING_MAX_MS - 1 })).toBe('skip-pending');
    });
    it('rebuilds the engine once the pending CONNECT is stale', () => {
        expect(decideConnect({ connected: false, pendingSince: 1000, now: 1000 + CONNECT_PENDING_MAX_MS })).toBe('restart');
    });
    it('treats a backwards clock as stale instead of wedging', () => {
        expect(decideConnect({ connected: false, pendingSince: 5000, now: 1000 })).toBe('restart');
    });
});

describe('SocketConnectGuard', () => {
    it('incident timing: interval + soon-timer while the server accepts slowly → one CONNECT on the wire', () => {
        let now = 0;
        const socket = new FakeSocket();
        const guard = new SocketConnectGuard(socket, { now: () => now });
        guard.connect('initial');
        now = 1000; expect(guard.connect('reconnect-soon')).toBe('skip-pending');
        now = 3000; expect(guard.connect('reconnect-interval')).toBe('skip-pending');
        now = 6000; expect(guard.connect('reconnect-interval')).toBe('skip-pending');
        expect(socket.connectPacketsOnEngine).toBe(1);
        socket.connected = true;
        socket.emit('connect');
        expect(guard.connect('reconnect-interval')).toBe('skip-connected');
        expect(socket.connectCalls).toBe(1);
    });

    it('a stuck CONNECT is replaced by a fresh engine, never stacked', () => {
        let now = 0;
        const socket = new FakeSocket();
        const guard = new SocketConnectGuard(socket, { now: () => now });
        guard.connect('initial');
        now = CONNECT_PENDING_MAX_MS;
        expect(guard.connect('reconnect-interval')).toBe('restart');
        expect(socket.disconnectCalls).toBe(1);
        expect(socket.connectCalls).toBe(2);
        expect(socket.connectPacketsOnEngine).toBe(1);
        expect(guard.pendingSinceMs).toBe(CONNECT_PENDING_MAX_MS);
    });

    it.each(['connect', 'connect_error', 'disconnect'])('%s clears the pending mark', (event) => {
        let now = 0;
        const socket = new FakeSocket();
        const guard = new SocketConnectGuard(socket, { now: () => now });
        guard.connect('initial');
        socket.emit(event, event === 'connect_error' ? new Error('x') : 'transport close');
        now = 10;
        expect(guard.connect('retry')).toBe('connect');
        expect(socket.connectCalls).toBe(2);
    });

    it('an autoConnect socket is treated as pending from birth', () => {
        const socket = new FakeSocket();
        socket.active = true;
        const guard = new SocketConnectGuard(socket, { now: () => 0 });
        expect(guard.connect('reconnect-soon')).toBe('skip-pending');
        expect(socket.connectCalls).toBe(0);
    });

    it('connectGuarded reuses one guard per socket', () => {
        const socket = new FakeSocket();
        expect(connectGuarded(socket, 'a')).toBe('connect');
        expect(connectGuarded(socket, 'b')).toBe('skip-pending');
        expect(socket.connectCalls).toBe(1);
    });
});

describe('CLI control sockets only connect through the guard', () => {
    // Source pin (verified with scripts/dev/mutation-check.mjs): a bare
    // `.connect()` on a control socket brings the double CONNECT back.
    it.each(['apiSession.ts', 'apiMachine.ts'])('%s has no bare socket.connect()', (file) => {
        const source = readFileSync(join(__dirname, file), 'utf8');
        expect(source).not.toMatch(/(?:this\.socket|candidate|controlSocket)\.connect\(\)/);
        expect(source).toMatch(/connectGuarded\(this\.socket, 'reconnect-interval'/);
        expect(source).toMatch(/connectGuarded\(this\.socket, 'reconnect-soon'/);
        expect(source).toMatch(/socketConnectGuard\(socket, guardOptions\)/);
    });
});
