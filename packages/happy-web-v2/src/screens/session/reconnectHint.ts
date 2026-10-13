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
