/**
 * B-543 — one engine connection, one namespace, at most ONE socket.
 *
 * socket.io-client 4.8 `Socket.connect()` re-sends a CONNECT packet when the
 * manager is already `open` but this socket's previous CONNECT has not been
 * acknowledged yet (`connect(): if ("open" === this.io._readyState) this.onopen()`).
 * The CLI reconnect loops call `connect()` from a 3 s interval plus a 1 s
 * timeout, so a server that takes longer than that to accept (auth, connection
 * limiter, bounded recovery queue during a deploy) receives TWO CONNECTs on one
 * engine connection. The server then holds two `Socket`s for the same client:
 * inbound packets (acks included) route to the newest, while the older orphan
 * stays in every room — RPC calls routed to it always time out
 * (2026-10-11, spec `specs/2026-10-socket-singleton-and-rewind-reconcile.md` §A).
 *
 * The rule this module encodes:
 *  - never call `connect()` while connected or while a CONNECT is pending;
 *  - a CONNECT pending longer than CONNECT_PENDING_MAX_MS is treated as stuck:
 *    `disconnect()` (drops the whole engine) then `connect()` (new engine), so
 *    the retry can never stack a second CONNECT on the old wire;
 *  - the pending mark is cleared on `connect` / `connect_error` / `disconnect`.
 *
 * Every manual `connect()` on a CLI control socket goes through
 * `connectGuarded()`.
 */

export const CONNECT_PENDING_MAX_MS = 15_000;

export type ConnectDecision = 'skip-connected' | 'skip-pending' | 'connect' | 'restart';

export function decideConnect(input: {
    connected: boolean;
    pendingSince: number | null;
    now: number;
    maxPendingMs?: number;
}): ConnectDecision {
    if (input.connected) return 'skip-connected';
    if (input.pendingSince === null) return 'connect';
    const maxPendingMs = input.maxPendingMs ?? CONNECT_PENDING_MAX_MS;
    // A clock that jumped backwards must not wedge the guard forever.
    const age = input.now - input.pendingSince;
    if (age < 0 || age >= maxPendingMs) return 'restart';
    return 'skip-pending';
}

/** The slice of a socket.io-client `Socket` the guard needs. */
export interface GuardableSocket {
    readonly connected: boolean;
    /** socket.io-client: true once `connect()`/`open()` subscribed to the manager. */
    readonly active?: boolean;
    connect(): unknown;
    disconnect(): unknown;
    on(event: 'connect' | 'connect_error' | 'disconnect', listener: (...args: any[]) => void): unknown;
}

export interface SocketConnectGuardOptions {
    now?: () => number;
    maxPendingMs?: number;
    log?: (message: string) => void;
}

export class SocketConnectGuard {
    private pendingSince: number | null = null;
    private readonly now: () => number;

    constructor(private readonly socket: GuardableSocket, private readonly options: SocketConnectGuardOptions = {}) {
        this.now = options.now ?? Date.now;
        const clear = () => { this.pendingSince = null; };
        socket.on('connect', clear);
        socket.on('connect_error', clear);
        socket.on('disconnect', clear);
        // A socket created with autoConnect already sent (or is about to send)
        // its CONNECT before the guard existed.
        if (socket.active && !socket.connected) this.pendingSince = this.now();
    }

    connect(reason: string): ConnectDecision {
        const now = this.now();
        const decision = decideConnect({
            connected: this.socket.connected,
            pendingSince: this.pendingSince,
            now,
            maxPendingMs: this.options.maxPendingMs,
        });
        if (decision === 'skip-connected') return decision;
        if (decision === 'skip-pending') {
            this.options.log?.(`[socket-guard] ${reason}: CONNECT pending ${now - this.pendingSince!}ms — not sending another`);
            return decision;
        }
        if (decision === 'restart') {
            this.options.log?.(`[socket-guard] ${reason}: CONNECT pending ${now - this.pendingSince!}ms — rebuilding the engine connection`);
            this.pendingSince = null;
            // Not connected here, so this emits no 'disconnect'; it tears down the
            // manager's engine so the next connect() opens a fresh one.
            this.socket.disconnect();
        }
        this.pendingSince = now;
        this.socket.connect();
        return decision;
    }

    /** Test/diagnostic view. */
    get pendingSinceMs(): number | null {
        return this.pendingSince;
    }
}

const guards = new WeakMap<GuardableSocket, SocketConnectGuard>();

/** Attach (once) and return the guard for a socket. Attach before the first connect(). */
export function socketConnectGuard(socket: GuardableSocket, options?: SocketConnectGuardOptions): SocketConnectGuard {
    let guard = guards.get(socket);
    if (!guard) {
        guard = new SocketConnectGuard(socket, options);
        guards.set(socket, guard);
    }
    return guard;
}

/** The only way CLI code should call `connect()` on a long-lived control socket. */
export function connectGuarded(socket: GuardableSocket, reason: string, options?: SocketConnectGuardOptions): ConnectDecision {
    return socketConnectGuard(socket, options).connect(reason);
}
