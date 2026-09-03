import type { AttachmentPreview } from '@/sync/attachmentTypes';
import type { MessageModeMeta } from '@/sync/messageMeta';

export type QueuedMessage = {
    id: string;
    text: string;
    createdAt: number;
    modeMeta: MessageModeMeta;
    attachments?: AttachmentPreview[];
};

export type PersistedQueuedMessage = Omit<QueuedMessage, 'attachments'>;
export type QueueDeliveryPhase = 'idle' | 'waiting-start' | 'waiting-finish' | 'intervening';

/**
 * B-322: how long `waiting-start` may wait for a turn that may never begin.
 * Generous on purpose — the normal path leaves this state within one render of
 * the agent picking the message up; this only has to beat "never".
 */
export const QUEUE_START_TIMEOUT_MS = 30_000;

/**
 * B-322 —— `waiting-start` used to be a state with NO EXIT.
 *
 * The only edge out of it required observing `isWorking === true` at least
 * once, i.e. it assumed the message we just released always makes the agent
 * start working. Three ways that assumption is false, all reachable today:
 *   ① `sync.sendMessage` returns silently (no throw) when the session or its
 *      encryption key is missing — the release effect's `.catch` never fires,
 *      so the phase is never reset AND the message is silently lost;
 *   ② the released item is a `/btw` command — `sendQueuedItem` opens the panel
 *      and returns without sending, same outcome;
 *   ③ the write lands but no live wrapper ever picks it up.
 * In all three the rest of the queue is stuck forever and only opening a new
 * tab recovers it (a fresh mount resets this ref) — which is precisely the
 * "开个新 chrome tab 就好了" the users reported. Verified by iterating this
 * function 1000× with isWorking=false before the fix: still `waiting-start`.
 */
export function advanceQueueDeliveryPhase(
    phase: QueueDeliveryPhase,
    isWorking: boolean,
    waitingStartAgeMs = 0,
): QueueDeliveryPhase {
    if (isWorking && phase === 'waiting-start') return 'waiting-finish';
    if (!isWorking && phase === 'waiting-finish') return 'idle';
    if (!isWorking && phase === 'waiting-start' && waitingStartAgeMs >= QUEUE_START_TIMEOUT_MS) return 'idle';
    return phase;
}

/** B-265: an archived session's queue must not release into the void — the
 *  message would sit on the server and be skipped by the resumed process.
 *  `gate` comes from sessionRestore.composerGate; 'restore-first' holds the
 *  queue until the session is back (archivedAt cleared + online). */
export function canReleaseQueuedMessage(
    phase: QueueDeliveryPhase,
    isWorking: boolean,
    gate: 'send' | 'restore-first' = 'send',
): boolean {
    return gate === 'send' && phase === 'idle' && !isWorking;
}

export function updateQueuedMessage(
    queue: QueuedMessage[],
    id: string,
    text: string,
): QueuedMessage[] {
    const trimmed = text.trim();
    if (!trimmed) return queue;
    return queue.map((item) => item.id === id ? { ...item, text: trimmed } : item);
}

export function removeQueuedMessage(queue: QueuedMessage[], id: string): QueuedMessage[] {
    return queue.filter((item) => item.id !== id);
}

export function persistableQueuedMessages(queue: QueuedMessage[]): PersistedQueuedMessage[] {
    return queue
        .filter((item) => !item.attachments?.length)
        .map(({ attachments: _attachments, ...item }) => item);
}

export function parsePersistedQueuedMessages(value: unknown): PersistedQueuedMessage[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const candidate = item as Record<string, unknown>;
        if (
            typeof candidate.id !== 'string'
            || typeof candidate.text !== 'string'
            || !candidate.text.trim()
            || typeof candidate.createdAt !== 'number'
            || !candidate.modeMeta
            || typeof candidate.modeMeta !== 'object'
        ) return [];
        return [{
            id: candidate.id,
            text: candidate.text,
            createdAt: candidate.createdAt,
            modeMeta: candidate.modeMeta as MessageModeMeta,
        }];
    });
}
