import type { Socket } from 'socket.io';
import { log } from './log';

const DISCONNECT_CODES: Record<string, string> = {
    'transport close': 'transport-close',
    'transport error': 'transport-error',
    'ping timeout': 'ping-timeout',
    'client namespace disconnect': 'client-disconnect',
    'server namespace disconnect': 'server-disconnect',
    'server shutting down': 'server-shutdown',
    'parse error': 'parse-error',
    'forced close': 'forced-close',
    'forced server close': 'forced-server-close',
};

/** Client identity is self-reported: allow only our known products, numeric versions, and Web build SHAs. */
export function diagnosticClient(raw: unknown): string {
    return typeof raw === 'string' && raw.length <= 96 &&
        (/^(?:cli-coding-session|cli-daemon|cli-control-plane|cli-session-ops|ios|android|web|desktop)\/(?:\d{1,6}\.\d{1,6}\.\d{1,6}|dev)$/.test(raw) ||
            /^(?:web|desktop)\/[a-f0-9]{7,40}$/.test(raw))
        ? raw : 'unknown';
}

export function disconnectCode(raw: unknown): string {
    return typeof raw === 'string' && Object.prototype.hasOwnProperty.call(DISCONNECT_CODES, raw) ? DISCONNECT_CODES[raw] : 'unknown';
}

type Context = {
    module: 'websocket' | 'relay';
    userId: string;
    machineId?: string;
    sessionId?: string;
    clientType: string;
    happyClient?: unknown;
};

/** Default lifecycle telemetry; never inspect handshake headers, addresses, or payloads.
 * `code` and `connectionType` survive logSafety; a `reason` field intentionally does not.
 * Capture ids once because Socket.IO clears its id during disconnect cleanup.
 */
export function attachSocketDiagnostics(
    socket: Socket,
    context: Context,
    write: (metadata: Record<string, unknown>, message: string) => void = log,
    now: () => number = () => performance.now(),
): void {
    const startedAt = now();
    const { happyClient, ...identity } = context;
    const base = { ...identity, socketId: socket.id, client: diagnosticClient(happyClient) };
    const connectionType = () => socket.conn.transport.name === 'websocket' ? 'websocket'
        : socket.conn.transport.name === 'polling' ? 'polling' : 'unknown';
    write({ ...base, event: 'socket-connected', connectionType: connectionType(), recovered: socket.recovered }, 'Socket connected');
    socket.once('disconnect', (reason) => {
        write({
            ...base,
            event: 'socket-disconnected',
            connectionType: connectionType(),
            durationMs: Math.max(0, Math.round(now() - startedAt)),
            code: disconnectCode(reason),
        }, 'Socket disconnected');
    });
}
