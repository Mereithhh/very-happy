/**
 * Live session stream relay (B-309) — pure socket routing, zero persistence.
 *
 * A Claude SDK session process pushes token-level drafts (thinking / text
 * deltas and quantified progress) while a turn is running; the server fans
 * them out to the owning account's web clients. Deliberately NOT the message
 * path: these frames never touch the database, never consume a session seq,
 * never enter history, and are never replayed. The persisted envelope stream
 * remains the single source of truth — a draft only exists to be replaced by
 * it.
 *
 * Shape is copied from clipboardHandler for the same load-bearing reasons:
 *   - `payload` is opaque here. The producer encrypts it with the SESSION key,
 *     so thinking text — the most sensitive content a session produces —
 *     stays unreadable to the relay, exactly like clipboard and file-preview.
 *   - `sessionId` is stamped from the AUTHENTICATED connection, never from the
 *     event body, so one session cannot publish drafts as another.
 *   - every field the client decodes must be forwarded explicitly.
 *
 * Two deliberate differences from clipboard:
 *   - only session-scoped connections may push (a machine daemon has no turn
 *     to stream, and a web client has no business fanning out drafts);
 *   - over-budget frames are DROPPED, not grounds for disconnect. These frames
 *     are disposable by construction; killing the socket would take the
 *     session's real message path down along with them.
 */
import { Server, Socket } from "socket.io";
import { AccountTerminalRateLimiter, allowDroppableRelay } from './terminalRateLimit';
import { sessionStreamFramesCounter } from '@/app/monitoring/metrics2';

type Conn = { connectionType: string; machineId?: string; sessionId?: string };

/** Ciphertext cap in bytes. A frame carries at most one 80ms coalescing
 *  window of deltas (wire caps the plaintext delta at 32KB); encryption plus
 *  base64 inflate that by ~4/3, so 64KB is a generous ceiling and still 16x
 *  below the clipboard relay's. Anything larger did not come from a
 *  well-behaved producer. */
export const MAX_STREAM_PAYLOAD_BYTES = 64 * 1024;

/** Kill switch. Drafts are pure enhancement, so an operator must be able to
 *  cut the traffic without rolling back an image. */
export function sessionStreamEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SESSION_STREAM_RELAY_DISABLED !== '1';
}

export interface SessionStreamPushEvent {
    payload: string;
    enc?: boolean;
}

export function sessionStreamHandler(
    userId: string,
    socket: Socket,
    io: Server,
    connection: Conn,
    rateLimiter?: AccountTerminalRateLimiter,
) {
    if (connection.connectionType !== 'session-scoped' || !connection.sessionId) return;
    if (!sessionStreamEnabled()) return;
    const sessionId = connection.sessionId;
    const userRoom = `user:${userId}:user-scoped`;

    socket.on('session-stream', (data: SessionStreamPushEvent) => {
        // Charge the untrusted body BEFORE any validation. Charging only what
        // survives validation lets an oversized or malformed frame consume
        // decode bandwidth for free — the exact hole terminalRateLimit's own
        // comment warns about, and why clipboard/file-preview charge first.
        if (!allowDroppableRelay({ limiter: rateLimiter, accountId: userId, payload: data })) {
            sessionStreamFramesCounter.inc({ outcome: 'throttled' });
            return;
        }
        if (!data || typeof data.payload !== 'string'
            || Buffer.byteLength(data.payload, 'utf8') > MAX_STREAM_PAYLOAD_BYTES
            || (data.enc !== undefined && typeof data.enc !== 'boolean')) {
            sessionStreamFramesCounter.inc({ outcome: 'rejected' });
            return;
        }
        sessionStreamFramesCounter.inc({ outcome: 'relayed' });
        io.to(userRoom).emit('session-stream', {
            sessionId,
            payload: data.payload,
            enc: data.enc === true,
        });
    });
}
