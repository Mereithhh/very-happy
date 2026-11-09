/**
 * B-864 — invariant: a session has at most ONE live agent connection.
 *
 * The wrapper-side single-writer lock (B-272, `happy-cli/src/utils/sessionLock.ts`)
 * is per machine and per HAPPY_HOME_DIR and can be raced; when two wrappers
 * slip through, both join `user:U:session:S`, both receive every user message
 * and both run it (a user 11-02: a second Claude process on the same session
 * started a paid calibration nobody could see). The server is the one place
 * every agent connection passes, so it arbitrates: the NEWEST agent process
 * wins, every older one is told it was superseded and disconnected.
 *
 * Identity rides on the handshake (`auth.agentInstance` + `auth.agentStartedAt`,
 * one value per wrapper process). Ordering by process start time — not by
 * connect time — makes the verdict independent of reconnect order: a stale
 * wrapper that reconnects after the newer one is rejected instead of kicking it
 * (no ping-pong), and two replicas deciding concurrently agree.
 *
 *   - same instance (release handover candidate, transport reconnect) → never evicted
 *   - newcomer with identity, no newer peer → admitted; older + legacy peers evicted
 *   - newcomer with identity, a newer peer exists → rejected (it is the stale one)
 *   - legacy newcomer (CLI without identity) while an identity peer is live → rejected
 *   - legacy among legacy only → unchanged pre-B-864 behaviour
 *   - sockets that are not agent wrappers (no identity, no `cli-coding-session/`
 *     client tag, e.g. the happy-agent prototype) are ignored both ways.
 *
 * Spec: specs/2026-11-session-single-agent-connection.md.
 */

export const SESSION_SUPERSEDED_ERROR = 'Session superseded';
export const SESSION_SUPERSEDED_EVENT = 'session-superseded';
const AGENT_CLIENT_PREFIX = 'cli-coding-session/';
const MAX_INSTANCE_LENGTH = 128;

export interface AgentIdentity {
    instance: string;
    startedAt: number;
}

export interface AgentPeer {
    id: string;
    identity: AgentIdentity | null;
    happyClient?: string;
}

export type AgentAdmission =
    | { admit: true; evict: AgentPeer[] }
    | { admit: false; holder: AgentPeer };

export function parseAgentIdentity(auth: unknown): AgentIdentity | null {
    if (!auth || typeof auth !== 'object') return null;
    const { agentInstance, agentStartedAt } = auth as { agentInstance?: unknown; agentStartedAt?: unknown };
    if (typeof agentInstance !== 'string' || agentInstance.length === 0 || agentInstance.length > MAX_INSTANCE_LENGTH) return null;
    if (typeof agentStartedAt !== 'number' || !Number.isSafeInteger(agentStartedAt) || agentStartedAt <= 0) return null;
    return { instance: agentInstance, startedAt: agentStartedAt };
}

/** Socket data written by the middleware; works for local and remote (fetchSockets) sockets. */
export function agentPeerOf(socket: { id: string; data?: any }): AgentPeer | null {
    const data = socket.data ?? {};
    if (data.clientType !== 'session-scoped') return null;
    const identity: AgentIdentity | null = typeof data.agentInstance === 'string' && typeof data.agentStartedAt === 'number'
        ? { instance: data.agentInstance, startedAt: data.agentStartedAt }
        : null;
    const happyClient = typeof data.happyClient === 'string' ? data.happyClient : undefined;
    if (!identity && !happyClient?.startsWith(AGENT_CLIENT_PREFIX)) return null;
    return { id: socket.id, identity, ...(happyClient ? { happyClient } : {}) };
}

/** Positive when `a` is the newer agent process. Total order: start time, then instance id. */
function compareIdentity(a: AgentIdentity, b: AgentIdentity): number {
    if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt;
    return a.instance < b.instance ? -1 : a.instance > b.instance ? 1 : 0;
}

export function decideAgentAdmission(self: AgentPeer, peers: readonly AgentPeer[]): AgentAdmission {
    const others = peers.filter((peer) => peer.id !== self.id
        && !(self.identity && peer.identity && peer.identity.instance === self.identity.instance));
    const me = self.identity;
    if (!me) {
        const holder = others
            .filter((peer) => peer.identity)
            .sort((a, b) => compareIdentity(b.identity!, a.identity!))[0];
        return holder ? { admit: false, holder } : { admit: true, evict: [] };
    }
    const newer = others
        .filter((peer) => peer.identity && compareIdentity(peer.identity, me) > 0)
        .sort((a, b) => compareIdentity(b.identity!, a.identity!))[0];
    if (newer) return { admit: false, holder: newer };
    return { admit: true, evict: others };
}

export type SupersededOutcome = 'evicted' | 'rejected';

/**
 * The two enforcement points, bound to a socket.io server (socket.ts wiring;
 * the integration spec runs the same object against a real server + clients).
 *   - `admit` (middleware, before any room join): records the handshake
 *     identity on `socket.data`, evicts older agents, refuses a stale one.
 *   - `afterJoin` (connection handler, after the room join): closes the race
 *     of two newcomers whose middleware checks could not see each other.
 */
export function createSessionAgentGuard(params: {
    roomOf: (userId: string, sessionId: string) => string;
    fetchRoom: (room: string) => Promise<ArbitrationSocket[]>;
    record: (event: { userId: string; sessionId: string; stale: AgentPeer; winner: AgentPeer | null; outcome: SupersededOutcome }) => void;
    onError?: (error: unknown, sessionId: string) => void;
}) {
    const fetchPeers = (userId: string, sessionId: string) => () => params.fetchRoom(params.roomOf(userId, sessionId));
    return {
        async admit(socket: ArbitrationSocket & { handshake: { auth: unknown } }, userId: string, sessionId: string): Promise<boolean> {
            const identity = parseAgentIdentity(socket.handshake.auth);
            if (identity) {
                socket.data.agentInstance = identity.instance;
                socket.data.agentStartedAt = identity.startedAt;
            }
            const self = agentPeerOf(socket);
            if (!self) return true;
            const verdict = await arbitrateSessionAgent({
                self,
                sessionId,
                fetchPeers: fetchPeers(userId, sessionId),
                onEvict: (peer) => params.record({ userId, sessionId, stale: peer, winner: self, outcome: 'evicted' }),
            });
            if (!verdict.admitted) params.record({ userId, sessionId, stale: self, winner: verdict.holder ?? null, outcome: 'rejected' });
            return verdict.admitted;
        },
        afterJoin(socket: ArbitrationSocket & { connected: boolean }, userId: string, sessionId: string): void {
            const self = agentPeerOf(socket);
            if (!self) return;
            void arbitrateSessionAgent({
                self,
                sessionId,
                fetchPeers: fetchPeers(userId, sessionId),
                onEvict: (peer) => params.record({ userId, sessionId, stale: peer, winner: self, outcome: 'evicted' }),
            }).then((verdict) => {
                if (verdict.admitted || !socket.connected) return;
                params.record({ userId, sessionId, stale: self, winner: verdict.holder ?? null, outcome: 'evicted' });
                socket.emit(SESSION_SUPERSEDED_EVENT, supersededNotice(sessionId, verdict.holder ?? null));
                socket.disconnect(true);
            }).catch((error) => params.onError?.(error, sessionId));
        },
    };
}

export interface SupersededNotice {
    sessionId: string;
    by: { startedAt: number; happyClient?: string } | null;
}

export function supersededNotice(sessionId: string, by: AgentPeer | null): SupersededNotice {
    return {
        sessionId,
        by: by?.identity ? { startedAt: by.identity.startedAt, ...(by.happyClient ? { happyClient: by.happyClient } : {}) } : null,
    };
}

interface ArbitrationSocket {
    id: string;
    data?: any;
    emit(event: string, payload: unknown): unknown;
    disconnect(close?: boolean): unknown;
}

export interface ArbitrationResult {
    admitted: boolean;
    holder?: AgentPeer;
    evicted: AgentPeer[];
}

/**
 * Look up the session room (cross-replica) and apply the verdict to the peers.
 * `self` is the newcomer's peer view; the caller rejects / disconnects it when
 * `admitted` is false. Lookup failure fails OPEN — connectivity first, the
 * post-join check and the next reconnect get another chance.
 */
export async function arbitrateSessionAgent(params: {
    self: AgentPeer;
    sessionId: string;
    fetchPeers: () => Promise<ArbitrationSocket[]>;
    onEvict?: (peer: AgentPeer) => void;
}): Promise<ArbitrationResult> {
    let sockets: ArbitrationSocket[];
    try {
        sockets = await params.fetchPeers();
    } catch {
        return { admitted: true, evicted: [] };
    }
    const byId = new Map<string, ArbitrationSocket>();
    const peers: AgentPeer[] = [];
    for (const socket of sockets) {
        const peer = agentPeerOf(socket);
        if (!peer) continue;
        byId.set(peer.id, socket);
        peers.push(peer);
    }
    const verdict = decideAgentAdmission(params.self, peers);
    if (!verdict.admit) return { admitted: false, holder: verdict.holder, evicted: [] };
    for (const peer of verdict.evict) {
        const socket = byId.get(peer.id);
        if (!socket) continue;
        socket.emit(SESSION_SUPERSEDED_EVENT, supersededNotice(params.sessionId, params.self));
        socket.disconnect(true);
        params.onEvict?.(peer);
    }
    return { admitted: true, evicted: verdict.evict };
}
