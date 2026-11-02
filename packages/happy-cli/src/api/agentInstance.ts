import { randomUUID } from 'node:crypto';

/**
 * B-864: who this wrapper process is, sent on every session-scoped handshake
 * (central socket, release-handover candidate, regional relay). The server
 * keeps one live agent connection per session and the NEWEST process wins, so
 * `agentStartedAt` is the process start time (stable across reconnects of the
 * same process) and `agentInstance` breaks ties and lets the server tell this
 * process's own sockets apart from another wrapper's.
 */
export const agentInstanceAuth: Readonly<{ agentInstance: string; agentStartedAt: number }> = Object.freeze({
    agentInstance: randomUUID(),
    agentStartedAt: Math.floor(performance.timeOrigin),
});

export const SESSION_SUPERSEDED_ERROR = 'Session superseded';

export interface SessionSupersededNotice {
    sessionId: string;
    by: { startedAt: number; happyClient?: string } | null;
}
