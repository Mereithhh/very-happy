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

export function advanceQueueDeliveryPhase(
    phase: QueueDeliveryPhase,
    isWorking: boolean,
): QueueDeliveryPhase {
    if (isWorking && phase === 'waiting-start') return 'waiting-finish';
    if (!isWorking && phase === 'waiting-finish') return 'idle';
    return phase;
}

export function canReleaseQueuedMessage(phase: QueueDeliveryPhase, isWorking: boolean): boolean {
    return phase === 'idle' && !isWorking;
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
