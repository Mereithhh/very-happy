import { describe, expect, it } from 'vitest';
import {
    advanceQueueDeliveryPhase,
    canReleaseQueuedMessage,
    parsePersistedQueuedMessages,
    persistableQueuedMessages,
    removeQueuedMessage,
    updateQueuedMessage,
    type QueuedMessage,
} from './queuedMessages';

const item = (id: string, text = id): QueuedMessage => ({
    id,
    text,
    createdAt: 1,
    modeMeta: { model: 'sonnet', effort: 'high' },
});

describe('queuedMessages', () => {
    it('edits one item without changing order or siblings', () => {
        const queue = [item('a'), item('b')];
        expect(updateQueuedMessage(queue, 'a', ' revised ')).toEqual([
            { ...queue[0], text: 'revised' },
            queue[1],
        ]);
    });

    it('rejects an empty edit and removes only the selected item', () => {
        const queue = [item('a'), item('b')];
        expect(updateQueuedMessage(queue, 'a', '   ')).toBe(queue);
        expect(removeQueuedMessage(queue, 'a')).toEqual([queue[1]]);
    });

    it('does not persist blob-backed attachment items across reload', () => {
        const plain = item('plain');
        const attached = { ...item('image'), attachments: [{ id: 'x', uri: 'blob:x', name: 'x.png', mimeType: 'image/png', size: 1, width: 1, height: 1 }] };
        expect(persistableQueuedMessages([plain, attached])).toEqual([plain]);
    });

    it('drops malformed persisted entries', () => {
        expect(parsePersistedQueuedMessages([item('ok'), null, { id: 'bad' }])).toEqual([item('ok')]);
    });

    it('releases at most one message per observed agent turn', () => {
        expect(canReleaseQueuedMessage('idle', false)).toBe(true);
        const waiting = advanceQueueDeliveryPhase('waiting-start', false);
        expect(canReleaseQueuedMessage(waiting, false)).toBe(false);
        const running = advanceQueueDeliveryPhase(waiting, true);
        expect(running).toBe('waiting-finish');
        expect(canReleaseQueuedMessage(running, true)).toBe(false);
        expect(advanceQueueDeliveryPhase(running, false)).toBe('idle');
    });
});
