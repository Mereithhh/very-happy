/**
 * Clipboard push relay (zero new deps — pure socket routing).
 *
 * One direction only: a machine daemon or a session process pushes clipboard
 * text; the server fans it out to every web client of the OWNING account
 * (user-scoped room). There is no web→machine direction, so no ownership
 * lookup is needed — the source socket already authenticated as this account.
 *
 * `payload` is opaque to the relay: producers encrypt it with the per-machine
 * key (daemon path) or the session key (SDK-session path) and set `enc`; the
 * client picks the right key from `sourceType` + `machineId`/`sessionId`,
 * which the relay stamps from the AUTHENTICATED connection — never from the
 * event body (a session could otherwise impersonate another source).
 *
 * Field passthrough matters (learned the hard way with terminal-output):
 * every field the client decodes — payload / enc / truncated / totalBytes —
 * must be explicitly forwarded here; dropping `enc` would make the client
 * paste ciphertext as if it were the text.
 */
import { Server, Socket } from "socket.io";

type Conn = { connectionType: string; machineId?: string; sessionId?: string };

/** Ciphertext/plaintext passthrough cap, in base64/string chars. Producers cap
 *  the plaintext at 256KB UTF-8; encryption + base64 inflate that by ~4/3 plus
 *  JSON-escape slack, so 1MB of chars is a generous hard ceiling — anything
 *  beyond it did not come from a well-behaved client and is dropped. */
const MAX_RELAY_PAYLOAD_CHARS = 1024 * 1024;

export interface ClipboardPushEvent {
    payload: string;
    enc?: boolean;
    truncated?: boolean;
    totalBytes?: number;
}

export function clipboardHandler(userId: string, socket: Socket, io: Server, connection: Conn) {
    // Only daemon (machine-scoped) and session processes may push; a plain
    // web client has no business fanning out clipboard events.
    const source =
        connection.connectionType === 'machine-scoped' && connection.machineId
            ? { sourceType: 'machine' as const, machineId: connection.machineId }
            : connection.connectionType === 'session-scoped' && connection.sessionId
                ? { sourceType: 'session' as const, sessionId: connection.sessionId }
                : null;
    if (!source) return;

    const userRoom = `user:${userId}:user-scoped`;

    socket.on('clipboard-push', (data: ClipboardPushEvent) => {
        if (!data || typeof data.payload !== 'string') return;
        if (data.payload.length > MAX_RELAY_PAYLOAD_CHARS) return;
        io.to(userRoom).emit('clipboard-push', {
            ...source,
            payload: data.payload,
            enc: data.enc === true,
            truncated: data.truncated === true,
            totalBytes: typeof data.totalBytes === 'number' ? data.totalBytes : undefined,
        });
    });
}
