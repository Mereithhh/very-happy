/**
 * B-568 ②: the composer says so when the browser↔server socket is down.
 *
 * Reads the one existing source (`storage.socketStatus` via useSocketStatus);
 * recovery itself stays on resumeSync → sync.onWebResume (AGENTS 13) — this
 * adds no focus/visibility listener and no reconnect of its own. A short delay
 * keeps a sub-second blip from flashing the placeholder.
 */
export const RECONNECT_HINT_DELAY_MS = 1500;

export type SocketStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export function isSocketDown(status: SocketStatus): boolean {
    return status !== 'connected';
}

/**
 * Only a LOST connection is a reconnect. The store starts as 'disconnected'
 * before the first connect, and a slow cold start (>1.5s) must not claim
 * 「重连中」 — until the socket has connected once, say nothing.
 */
export function isReconnecting(status: SocketStatus, everConnected: boolean): boolean {
    return everConnected && isSocketDown(status);
}
