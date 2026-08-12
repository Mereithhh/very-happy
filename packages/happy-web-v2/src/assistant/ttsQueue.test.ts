import { describe, it, expect } from 'vitest';
import {
    ttsQueueInitial,
    ttsEnqueue,
    ttsStartNext,
    ttsFinishCurrent,
    ttsStopAll,
    ttsIsActive,
} from './ttsQueue';

describe('ttsQueue', () => {
    it('plays enqueued utterances FIFO', () => {
        let s = ttsEnqueue(ttsQueueInitial, { id: 'a', text: 'one' });
        s = ttsEnqueue(s, { id: 'b', text: 'two' });

        const first = ttsStartNext(s);
        expect(first.next?.id).toBe('a');
        expect(first.state.playingId).toBe('a');

        const during = ttsStartNext(first.state);
        expect(during.next).toBeNull(); // nothing starts while playing

        const afterA = ttsFinishCurrent(first.state);
        const second = ttsStartNext(afterA);
        expect(second.next?.id).toBe('b');
    });

    it('dedupes by id — an utterance is never enqueued twice', () => {
        let s = ttsEnqueue(ttsQueueInitial, { id: 'a', text: 'one' });
        s = ttsEnqueue(s, { id: 'a', text: 'one again' });
        expect(s.queue).toHaveLength(1);
    });

    it('dedupes even after the utterance finished playing', () => {
        let s = ttsEnqueue(ttsQueueInitial, { id: 'a', text: 'one' });
        const started = ttsStartNext(s);
        s = ttsFinishCurrent(started.state);
        s = ttsEnqueue(s, { id: 'a', text: 'one re-delivered' });
        expect(s.queue).toHaveLength(0);
        expect(ttsStartNext(s).next).toBeNull();
    });

    it('stopAll clears the queue and playing marker but keeps dedupe memory', () => {
        let s = ttsEnqueue(ttsQueueInitial, { id: 'a', text: 'one' });
        s = ttsEnqueue(s, { id: 'b', text: 'two' });
        s = ttsStartNext(s).state;
        s = ttsStopAll(s);
        expect(s.queue).toHaveLength(0);
        expect(s.playingId).toBeNull();
        // re-delivery after stop must not re-read
        s = ttsEnqueue(s, { id: 'a', text: 'one' });
        s = ttsEnqueue(s, { id: 'b', text: 'two' });
        expect(s.queue).toHaveLength(0);
    });

    it('isActive reflects queued or playing state', () => {
        expect(ttsIsActive(ttsQueueInitial)).toBe(false);
        let s = ttsEnqueue(ttsQueueInitial, { id: 'a', text: 'one' });
        expect(ttsIsActive(s)).toBe(true);
        s = ttsStartNext(s).state;
        expect(ttsIsActive(s)).toBe(true);
        s = ttsFinishCurrent(s);
        expect(ttsIsActive(s)).toBe(false);
    });

    it('finishCurrent on idle state is a no-op', () => {
        expect(ttsFinishCurrent(ttsQueueInitial)).toBe(ttsQueueInitial);
    });
});
