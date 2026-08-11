/**
 * Clipboard push receiver (web side of the copy_to_clipboard tool).
 *
 * A machine daemon (terminal-path claude via `very-happy mcp`) or a session
 * process (SDK-path `happy` MCP server) pushes text; the server relays it as a
 * `clipboard-push` event to every web client of the account. This module
 * decrypts it with the matching key and lands it in the OS clipboard:
 *
 *  - page focused AND visible → try navigator.clipboard.writeText directly +
 *    light toast (see clipboardWriteGate for why hidden pages are excluded);
 *  - not focused / hidden / write rejected (browser gesture policy, common on
 *    mobile) →
 *    a persistent alert with a "Copy" button, so the write happens inside a
 *    real user gesture.
 *
 * Every open web client receives and surfaces the push (simple + predictable
 * for the multi-device case).
 */
import { Modal } from '@/modal';
import { toast } from '@/ui/Toast';
import { t } from '@/text';
import type { Encryption } from '@/sync/encryption/encryption';
import { canAttemptDirectWrite } from '@/sync/clipboardWriteGate';

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

/** Land the text in the clipboard, falling back to a user-gesture button when
 *  a direct write isn't allowed. Exported for reuse/tests. */
export async function deliverToClipboard(text: string): Promise<void> {
    // Direct write only stands a chance while the document is focused AND
    // visible (see canAttemptDirectWrite); even then some browsers (mobile
    // Safari) reject writes outside a gesture — any failure falls through to
    // the button path.
    const doc = typeof document !== 'undefined' ? document : undefined;
    if (canAttemptDirectWrite(doc) && await tryWrite(text)) {
        toast.success(t('common.copied'));
        return;
    }

    const preview = text.length > 300 ? `${text.slice(0, 300)}…` : text;
    Modal.alert(
        t('common.copy'),
        preview,
        [
            { text: t('common.cancel'), style: 'cancel' },
            {
                text: t('common.copy'),
                onPress: () => {
                    // Runs inside the button's click gesture → allowed everywhere.
                    void tryWrite(text).then((ok) => {
                        if (ok) toast.success(t('common.copied'));
                        else toast.error(t('common.error'));
                    });
                },
            },
        ],
    );
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
    await deliverToClipboard(text);
}
