/**
 * File preview push relay (zero new deps — pure socket routing).
 *
 * Same shape as clipboardHandler, and deliberately so: a session process (or a
 * machine daemon) asks every web client of the OWNING account to open a file
 * preview. One direction only (producer → user-scoped room), so no ownership
 * lookup is needed — the source socket already authenticated as this account.
 *
 * `payload` is an encrypted, base64-encoded **absolute file path**, not file
 * content: the web client decrypts the path with the key implied by
 * `sourceType` + `sessionId`/`machineId` and then fetches the bytes itself via
 * the existing `fs-read` RPC. The relay never decrypts anything.
 *
 * Two lessons carried over from clipboard/terminal-output, both load-bearing:
 *  a) Source identity is stamped from the AUTHENTICATED connection and NEVER
 *     read from the event body — otherwise one session could impersonate
 *     another session or a machine and make the client decrypt with the wrong
 *     key (or point the preview at another machine's filesystem).
 *  b) Every field the client decodes must be forwarded EXPLICITLY (no object
 *     spread of the incoming body): dropping `enc` would make the client treat
 *     ciphertext as a literal path, and spreading would let unknown/spoofed
 *     keys ride along.
 */
import { Server, Socket } from "socket.io";

type Conn = { connectionType: string; machineId?: string; sessionId?: string };

/** Hard cap in base64/string chars. The plaintext here is a filesystem path,
 *  so even a pathological one is well under 4KB; encryption + base64 inflate it
 *  by ~4/3. 8K chars is therefore already absurdly generous and far below the
 *  1MB clipboard ceiling — anything larger did not come from a well-behaved
 *  client and is dropped. */
const MAX_PATH_PAYLOAD_CHARS = 8 * 1024;

export type FilePreviewMode = 'file' | 'diff';

export interface FilePreviewPushEvent {
    payload: string;
    enc?: boolean;
    mode?: FilePreviewMode;
}

/** Unknown modes are normalized to 'file' rather than passed through, so a new
 *  CLI cannot make an old/new web client branch on a mode it does not know. */
function normalizeMode(mode: unknown): FilePreviewMode {
    return mode === 'diff' ? 'diff' : 'file';
}

export function filePreviewHandler(userId: string, socket: Socket, io: Server, connection: Conn) {
    // Only session processes and machine daemons may push; a plain web client
    // (user-scoped) has no business asking other clients to open previews.
    const source =
        connection.connectionType === 'machine-scoped' && connection.machineId
            ? { sourceType: 'machine' as const, machineId: connection.machineId }
            : connection.connectionType === 'session-scoped' && connection.sessionId
                ? { sourceType: 'session' as const, sessionId: connection.sessionId }
                : null;
    if (!source) return;

    const userRoom = `user:${userId}:user-scoped`;

    socket.on('file-preview-push', (data: FilePreviewPushEvent) => {
        if (!data || typeof data.payload !== 'string') return;
        if (data.payload.length === 0) return;
        if (data.payload.length > MAX_PATH_PAYLOAD_CHARS) return;
        io.to(userRoom).emit('file-preview-push', {
            ...source,
            payload: data.payload,
            enc: data.enc === true,
            mode: normalizeMode(data.mode),
        });
    });
}
