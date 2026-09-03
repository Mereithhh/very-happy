import { describe, expect, it } from 'vitest';
import {
    advanceQueueDeliveryPhase,
    QUEUE_START_TIMEOUT_MS,
    canReleaseQueuedMessage,
    parsePersistedQueuedMessages,
    persistableQueuedMessages,
    removeQueuedMessage,
    updateQueuedMessage,
    type QueuedMessage,
    type QueueDeliveryPhase,
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

describe('B-322: waiting-start is no longer a dead end', () => {
    it('used to have no exit while the agent never started', () => {
        // Reproduced against the real function before the fix: 1000 iterations
        // with isWorking=false and the phase never left 'waiting-start', so the
        // rest of the queue could only be recovered by opening a new tab.
        let phase: QueueDeliveryPhase = 'waiting-start';
        for (let i = 0; i < 1000; i++) phase = advanceQueueDeliveryPhase(phase, false, 0);
        expect(phase).toBe('waiting-start');
        expect(canReleaseQueuedMessage(phase, false)).toBe(false);
    });

    it('times out back to idle so the queue drains without a new tab', () => {
        expect(advanceQueueDeliveryPhase('waiting-start', false, QUEUE_START_TIMEOUT_MS - 1)).toBe('waiting-start');
        expect(advanceQueueDeliveryPhase('waiting-start', false, QUEUE_START_TIMEOUT_MS)).toBe('idle');
        expect(canReleaseQueuedMessage('idle', false)).toBe(true);
    });

    it('a turn that does start still wins over the timeout', () => {
        // The normal path must not be affected: an agent that picked the
        // message up moves to waiting-finish even past the deadline.
        expect(advanceQueueDeliveryPhase('waiting-start', true, 10 * QUEUE_START_TIMEOUT_MS)).toBe('waiting-finish');
    });
});
