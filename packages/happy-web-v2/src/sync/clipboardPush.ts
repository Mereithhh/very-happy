/**
 * Clipboard push receiver (web side of the copy_to_clipboard tool).
 *
 * A machine daemon (terminal-path claude via `very-happy mcp`) or a session
 * process (SDK-path `happy` MCP server) pushes text; the server relays it as a
 * `clipboard-push` event to every web client of the account. This module
 * decrypts it with the matching key, records it in the device-local history
 * (clipboardHistoryStore — every push, both outcomes below), and lands it in
 * the OS clipboard:
 *
 *  - auto-copy on (default) + page focused AND visible + write accepted →
 *    silent write + light toast with a preview (see clipboardWriteGate for
 *    why hidden pages are excluded);
 *  - otherwise (auto-copy off, page hidden/unfocused, or the browser rejected
 *    the write — gesture policy, common on mobile/iOS PWA) → NO blocking
 *    modal: a sticky clickable toast retries the write inside the click's
 *    user gesture, and the text is already in history as the fallback.
 *
 * The old edit-before-copy modal moved into the history panel (expand a row
 * to edit, then copy). Every open web client receives and surfaces the push
 * (simple + predictable for the multi-device case).
 */
import { toast } from '@/ui/Toast';
import { t } from '@/text';
import type { Encryption } from '@/sync/encryption/encryption';
import { canAttemptDirectWrite } from '@/sync/clipboardWriteGate';
import { addClipboardHistoryEntry } from '@/sync/clipboardHistoryStore';
import { clipboardPreview } from '@/sync/clipboardHistory';
import { storage } from '@/sync/storage';
import { getSessionName } from '@/utils/sessionUtils';
import { machineLabel } from '@/utils/machineUtils';

/** Defensive plaintext cap — producers already truncate at 256KB UTF-8; this
 *  guards a misbehaving producer from wedging the UI (chars ≥ bytes/4). */
const MAX_TEXT_CHARS = 256 * 1024;

/** How long to wait for the machine/session key to appear before giving up.
 *  A push can race the initial machines/sessions sync right after connect. */
const KEY_WAIT_MS = 12000;
const KEY_POLL_MS = 250;

export interface ClipboardPushEvent {
    sourceType: 'machine' | 'session';
    machineId?: string;
    sessionId?: string;
    payload: string;
    enc?: boolean;
    truncated?: boolean;
    totalBytes?: number;
}

interface RawDecryptor {
    decryptRaw(encrypted: string): Promise<any | null>;
}

async function resolveDecryptor(encryption: Encryption, data: ClipboardPushEvent): Promise<RawDecryptor | null> {
    const get = (): RawDecryptor | null => {
        if (data.sourceType === 'machine' && data.machineId) {
            return encryption.getMachineEncryption(data.machineId);
        }
        if (data.sourceType === 'session' && data.sessionId) {
            return encryption.getSessionEncryption(data.sessionId);
        }
        return null;
    };
    const start = Date.now();
    while (Date.now() - start < KEY_WAIT_MS) {
        const enc = get();
        if (enc) return enc;
        await new Promise((resolve) => setTimeout(resolve, KEY_POLL_MS));
    }
    return get();
}

async function tryWrite(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
}

/** Best-effort display label for the push source (session title / machine
 *  name). Data may not be synced yet right after connect — undefined then. */
function resolveSourceLabel(event: ClipboardPushEvent): string | undefined {
    try {
        const state = storage.getState();
        if (event.sourceType === 'session' && event.sessionId) {
            const session = state.sessions[event.sessionId];
            return session ? getSessionName(session) : undefined;
        }
        if (event.sourceType === 'machine' && event.machineId) {
            const machine = state.machines[event.machineId];
            return machine ? machineLabel(machine) : undefined;
        }
    } catch {
        // label is cosmetic — never let it break delivery
    }
    return undefined;
}

/** Land the text in the clipboard, degrading to a sticky tap-to-copy toast
 *  when a silent write isn't allowed. Exported for reuse/tests. */
export async function deliverToClipboard(text: string): Promise<void> {
    const preview = clipboardPreview(text);

    // Silent write only stands a chance while auto-copy is on and the document
    // is focused AND visible (see canAttemptDirectWrite); even then some
    // browsers (mobile Safari) reject writes outside a gesture — any failure
    // falls through to the toast path.
    const autoCopy = storage.getState().localSettings.clipboardAutoCopy;
    const doc = typeof document !== 'undefined' ? document : undefined;
    if (autoCopy && canAttemptDirectWrite(doc) && await tryWrite(text)) {
        toast.success(t('clipboard.copiedPreview', { preview }));
        return;
    }

    // Non-blocking fallback: a sticky toast whose click IS the user gesture,
    // so the retry write is allowed everywhere (iOS PWA included). The text
    // is already in the history panel — nothing is lost if it's dismissed.
    toast.action(t('clipboard.tapToCopy', { preview }), () => {
        void tryWrite(text).then((ok) => {
            if (ok) toast.success(t('clipboard.copiedPreview', { preview }));
            else toast.error(t('markdown.copyFailed'));
        });
    });
}

/** Entry point wired to `apiSocket.onMessage('clipboard-push', …)` in sync. */
export async function handleClipboardPush(encryption: Encryption, data: unknown): Promise<void> {
    const event = data as ClipboardPushEvent | null;
    if (!event || typeof event.payload !== 'string') return;

    let text: string;
    if (event.enc) {
        const decryptor = await resolveDecryptor(encryption, event);
        if (!decryptor) {
            console.warn('clipboard-push: no key available for source', event.sourceType, event.machineId ?? event.sessionId);
            return;
        }
        const plain = await decryptor.decryptRaw(event.payload);
        if (typeof plain !== 'string') {
            console.warn('clipboard-push: decrypt failed');
            return;
        }
        text = plain;
    } else {
        text = event.payload;
    }

    if (text.length === 0) return;
    if (text.length > MAX_TEXT_CHARS) {
        text = text.slice(0, MAX_TEXT_CHARS);
    }

    // History first (unconditional): the panel is the retry/recovery surface —
    // even a silently-copied push stays reviewable there.
    addClipboardHistoryEntry(text, {
        sourceType: event.sourceType,
        sourceId: event.sourceType === 'machine' ? event.machineId : event.sessionId,
        sourceLabel: resolveSourceLabel(event),
    });

    await deliverToClipboard(text);
}
