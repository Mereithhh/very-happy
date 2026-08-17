/**
 * File-preview push receiver (web side of the `open_preview` tool, B-131 /
 * `specs/2026-08-open-preview.md`).
 *
 * A session process (SDK-path `happy` MCP server) pushes an ENCRYPTED absolute
 * path; the server relays it as a `file-preview-push` event to every web client
 * of the account. This module decrypts it with the matching key, resolves which
 * machine should serve the file, and opens the singleton FsPreviewOverlay —
 * which then pulls the bytes over the existing `fs-read` machine RPC. Only the
 * PATH travels on the relay; no new file-access capability is introduced.
 *
 * Structure deliberately mirrors clipboardPush.ts, including the 12s key-wait
 * poll: a push right after connect races the first sessions/machines sync, so
 * the key (and the session row we need for machineId) may not exist yet.
 *
 * Failure discipline: a malformed payload, a failed decrypt or an empty path is
 * dropped with a console warning — never thrown (this runs on the socket
 * message path). A resolvable-but-unmapped source, on the other hand, gets a
 * TOAST: spec D2 forbids "nothing happens" for that case.
 */
import { toast } from '@/ui/Toast';
import { t } from '@/text';
import type { Encryption } from '@/sync/encryption/encryption';
import { storage } from '@/sync/storage';
import {
    normalizePreviewMode,
    normalizePreviewPath,
    resolvePreviewTarget,
    type FilePreviewPushEvent,
} from '@/sync/filePreview';
import { openFsPreview } from '@/sync/filePreviewOpen';

/** How long to wait for the session/machine key to appear before giving up.
 *  A push can race the initial machines/sessions sync right after connect. */
const KEY_WAIT_MS = 12000;
const KEY_POLL_MS = 250;

interface RawDecryptor {
    decryptRaw(encrypted: string): Promise<any | null>;
}

/** Poll `get` until it yields a value or the budget runs out. */
async function waitFor<T>(get: () => T | null | undefined, timeoutMs: number): Promise<T | null> {
    const start = Date.now();
    for (;;) {
        const value = get();
        if (value) return value;
        if (Date.now() - start >= timeoutMs) return get() ?? null;
        await new Promise((resolve) => setTimeout(resolve, KEY_POLL_MS));
    }
}

async function resolveDecryptor(encryption: Encryption, data: FilePreviewPushEvent): Promise<RawDecryptor | null> {
    return waitFor<RawDecryptor>(() => {
        if (data.sourceType === 'machine' && data.machineId) {
            return encryption.getMachineEncryption(data.machineId);
        }
        if (data.sourceType === 'session' && data.sessionId) {
            return encryption.getSessionEncryption(data.sessionId);
        }
        return null;
    }, KEY_WAIT_MS);
}

/** `session.metadata.machineId` lookup against the current store snapshot. */
function sessionMachineId(sessionId: string): string | undefined {
    try {
        return storage.getState().sessions[sessionId]?.metadata?.machineId ?? undefined;
    } catch {
        return undefined;
    }
}

/** Entry point wired to `apiSocket.onMessage('file-preview-push', …)` in sync. */
export async function handleFilePreviewPush(encryption: Encryption, data: unknown): Promise<void> {
    const event = data as FilePreviewPushEvent | null;
    if (!event || typeof event.payload !== 'string') return;
    if (event.sourceType !== 'session' && event.sourceType !== 'machine') {
        console.warn('file-preview-push: unknown sourceType', (event as any).sourceType);
        return;
    }

    // Device-local opt-out (Settings → Channels). Checked before any decrypt so
    // a device that opted out does no work at all.
    if (!storage.getState().localSettings.filePreviewReceive) return;

    let raw: unknown;
    if (event.enc) {
        const decryptor = await resolveDecryptor(encryption, event);
        if (!decryptor) {
            console.warn('file-preview-push: no key available for source', event.sourceType, event.machineId ?? event.sessionId);
            return;
        }
        raw = await decryptor.decryptRaw(event.payload);
        if (typeof raw !== 'string') {
            console.warn('file-preview-push: decrypt failed');
            return;
        }
    } else {
        raw = event.payload;
    }

    const path = normalizePreviewPath(raw);
    if (!path) {
        console.warn('file-preview-push: empty or unusable path');
        return;
    }

    // Wait for the session ROW, not for its machineId: the row can still be in
    // flight right after connect (same race as the key), but once it IS here a
    // missing machineId is a genuine miss that must be reported NOW — waiting
    // out the full budget would just delay the toast by 12s.
    if (event.sourceType === 'session' && event.sessionId) {
        const sessionId = event.sessionId;
        await waitFor(() => storage.getState().sessions[sessionId], KEY_WAIT_MS);
    }

    const target = resolvePreviewTarget(event, sessionMachineId);
    if (!target.ok) {
        // Loud on purpose (spec D2): the model believes it opened a preview, so
        // silence here is the worst possible outcome.
        console.warn('file-preview-push: cannot resolve a machine', target.reason, event.sessionId ?? event.machineId);
        toast.error(
            target.reason === 'session-without-machine'
                ? t('filePreview.noMachineForSession')
                : t('filePreview.noSource'),
        );
        return;
    }

    openFsPreview({ machineId: target.machineId, path, mode: normalizePreviewMode(event.mode) });
}
