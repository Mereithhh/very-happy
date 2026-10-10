/**
 * B-543 — invariant: one engine connection + one namespace = at most ONE
 * server Socket.
 *
 * socket.io-client 4.8 re-sends CONNECT when `connect()` is called on an open
 * manager whose previous CONNECT is still unacknowledged (the old CLI reconnect
 * loop did exactly that when the server accepted slowly). socket.io 4.8.3 then
 * builds a second `Socket` on the same engine client: `client.nsps` now routes
 * every inbound packet — acks included — to the newest one, while the older
 * Socket (the ORPHAN) stays in `nsp.sockets`, in every room (RPC rooms restored
 * by connection-state recovery) and in eventRouter. RPC routed to the orphan
 * reaches the client over the shared wire, the client answers, the answer is
 * routed to the other Socket, and `emitWithAck` on the orphan always times out.
 * Spec: specs/2026-10-socket-singleton-and-rewind-reconcile.md §A.
 *
 * Eviction removes the orphan exactly like a normal disconnect (rooms, nsp,
 * every `disconnect` listener → eventRouter / connection count / limiter lease)
 * but:
 *  - sends NO DISCONNECT packet (the client would take it as its CURRENT socket
 *    being kicked — it only has one);
 *  - leaves `client.nsps` alone (it already points at the live socket);
 *  - hands the orphan's pending acks to the live socket, so a call that was in
 *    flight when the second CONNECT landed still gets its answer (ack ids are
 *    allocated per namespace, `nsp._ids++`, so they cannot collide).
 *
 * This relies on socket.io 4.8 private fields (`client.sockets`, `client.nsps`,
 * `socket.acks`, `socket._onclose`). `socketOrphans.integration.spec.ts` pins
 * them with a real server + real client; a socket.io upgrade that changes them
 * fails that test.
 */
import type { Namespace, Socket } from 'socket.io';

export const ORPHAN_SWEEP_INTERVAL_MS = 60_000;
/** Reason seen by `disconnect` listeners. Not in socket.io's recoverable set → no session persisted. */
export const ORPHAN_EVICTION_REASON = 'server namespace disconnect';

export type OrphanEvictionTrigger = 'connection' | 'sweep';

export interface OrphanEviction {
    orphan: Socket;
    /** The socket that owns the engine client's namespace slot, if any. */
    live: Socket | undefined;
    trigger: OrphanEvictionTrigger;
    transferredAcks: number;
}

interface ClientInternals {
    sockets: Map<string, Socket>;
    nsps: Map<string, Socket>;
}

function clientOf(socket: Socket): ClientInternals | null {
    const client = (socket as unknown as { client?: Partial<ClientInternals> }).client;
    if (!client || !(client.sockets instanceof Map) || !(client.nsps instanceof Map)) return null;
    return client as ClientInternals;
}

/**
 * True for a LOCAL socket that no longer receives its engine client's inbound
 * packets. Remote sockets (fetchSockets from another replica) have no `client`
 * and are never orphans from this replica's point of view.
 */
export function isLocalOrphan(socket: unknown): boolean {
    const s = socket as Socket;
    if (!s || !(s as { connected?: boolean }).connected || !s.nsp) return false;
    const client = clientOf(s);
    if (!client) return false;
    return client.nsps.get(s.nsp.name) !== s;
}

function evictOne(orphan: Socket, trigger: OrphanEvictionTrigger): OrphanEviction | null {
    const client = clientOf(orphan);
    if (!client || !orphan.connected) return null;
    const live = client.nsps.get(orphan.nsp.name);
    if (live === orphan) return null;

    let transferredAcks = 0;
    const orphanAcks = (orphan as unknown as { acks?: Map<number, unknown> }).acks;
    const liveAcks = live && live.connected ? (live as unknown as { acks?: Map<number, unknown> }).acks : undefined;
    if (orphanAcks instanceof Map && liveAcks instanceof Map) {
        for (const [id, ack] of orphanAcks) {
            if (!liveAcks.has(id)) {
                liveAcks.set(id, ack);
                transferredAcks++;
            }
        }
        orphanAcks.clear();
    }

    // Detach from the engine client FIRST: `_onclose` → `client._remove(orphan)`
    // then finds no entry and leaves `client.nsps` (the live socket's mapping)
    // untouched. Without this it would delete the live socket's slot.
    if (client.sockets.get(orphan.id) === orphan) client.sockets.delete(orphan.id);
    // Same path as a real disconnect minus the DISCONNECT packet: leaves all
    // rooms, leaves nsp.sockets, runs every `disconnecting`/`disconnect` listener.
    (orphan as unknown as { _onclose(reason: string): void })._onclose(ORPHAN_EVICTION_REASON);
    return { orphan, live, trigger, transferredAcks };
}

/**
 * Call from `connection`: evicts every other socket of the same engine client
 * in the same namespace (they are orphans now — `client.nsps` points at
 * `current`).
 */
export function evictOrphansOf(current: Socket, onEvict?: (eviction: OrphanEviction) => void): number {
    const client = clientOf(current);
    if (!client) return 0;
    const siblings = [...client.sockets.values()].filter((s) => s !== current && s.nsp === current.nsp);
    let evicted = 0;
    for (const sibling of siblings) {
        const eviction = evictOne(sibling, 'connection');
        if (eviction) {
            evicted++;
            onEvict?.(eviction);
        }
    }
    return evicted;
}

/** Periodic safety net: evicts any local orphan in the namespace. */
export function sweepOrphans(nsp: Namespace, onEvict?: (eviction: OrphanEviction) => void): number {
    let evicted = 0;
    for (const socket of [...nsp.sockets.values()]) {
        if (!isLocalOrphan(socket)) continue;
        const eviction = evictOne(socket, 'sweep');
        if (eviction) {
            evicted++;
            onEvict?.(eviction);
        }
    }
    return evicted;
}
