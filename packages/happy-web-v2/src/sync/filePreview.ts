/**
 * filePreview — PURE logic + wire types for the `open_preview` tool (B-131,
 * `specs/2026-08-open-preview.md`). The effectful receiver lives in
 * `filePreviewPush.ts`, the UI in `screens/files/FsPreviewOverlay.tsx`; this
 * module is the part worth unit-testing on its own (same split as
 * clipboardHistory ↔ clipboardPush).
 *
 * Wire shape mirrors `clipboard-push`: the relay never sees the plaintext —
 * `payload` is `encodeBase64(encrypt(key, variant, absolutePath))` with
 * `enc: true`, and the SOURCE is stamped by the server from the authenticated
 * connection (we never trust an id the event body claims about itself beyond
 * what the server already vouched for).
 */

/** `diff` is a parameter placeholder only — B-036 (diff rendering) isn't built,
 *  so the overlay degrades to a plain preview and says so. */
export type FilePreviewMode = 'file' | 'diff';

export interface FilePreviewPushEvent {
    sourceType: 'session' | 'machine';
    sessionId?: string;
    machineId?: string;
    /** Encrypted (enc: true) or plaintext absolute path. */
    payload: string;
    enc?: boolean;
    mode?: FilePreviewMode;
}

/** Defensive cap on the decrypted path. Real paths are far shorter; this only
 *  guards a misbehaving producer from wedging the UI with a megabyte "path". */
export const MAX_PREVIEW_PATH_CHARS = 4096;

/** Validate/normalize a decrypted path. Returns null for anything unusable —
 *  callers drop the push silently (with a console warning) instead of throwing. */
export function normalizePreviewPath(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    // Trim only surrounding whitespace/newlines; interior spaces are legal in paths.
    const path = raw.trim();
    if (path.length === 0) return null;
    if (path.length > MAX_PREVIEW_PATH_CHARS) return null;
    // A NUL byte can only come from a broken producer and would confuse the
    // daemon's path handling.
    if (path.includes('\u0000')) return null;
    return path;
}

/** Unknown/absent mode ⇒ 'file' (forward compat: an older web must not break
 *  on a mode a newer CLI invents). */
export function normalizePreviewMode(mode: unknown): FilePreviewMode {
    return mode === 'diff' ? 'diff' : 'file';
}

export type PreviewTarget =
    | { ok: true; machineId: string }
    /** the event named neither a machine nor a session we can resolve */
    | { ok: false; reason: 'no-source' }
    /** session known (or at least named) but it carries no machineId */
    | { ok: false; reason: 'session-without-machine' };

/**
 * Which machine should serve the file.
 *
 * - `sourceType: 'machine'` → the machine itself (kept for wire symmetry with
 *   clipboard-push even though the daemon path is out of scope for B-131).
 * - `sourceType: 'session'` → the session's `metadata.machineId` (D2).
 *
 * The session lookup is injected so this stays pure/testable. A miss is
 * reported, never swallowed: spec D2 requires a visible degradation instead of
 * "nothing happens".
 */
export function resolvePreviewTarget(
    event: Pick<FilePreviewPushEvent, 'sourceType' | 'machineId' | 'sessionId'>,
    sessionMachineId: (sessionId: string) => string | undefined,
): PreviewTarget {
    if (event.sourceType === 'machine') {
        return event.machineId ? { ok: true, machineId: event.machineId } : { ok: false, reason: 'no-source' };
    }
    if (event.sourceType === 'session' && event.sessionId) {
        const machineId = sessionMachineId(event.sessionId);
        return machineId
            ? { ok: true, machineId }
            : { ok: false, reason: 'session-without-machine' };
    }
    return { ok: false, reason: 'no-source' };
}
