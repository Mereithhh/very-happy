import { describe, expect, it } from 'vitest';
import { discardedReasonKey, isTranscriptVisibleInput } from './discardedInput';

const base = { id: 'x', localId: 'l', createdAt: 1, kind: 'user-text' as const, text: 'hi' };

describe('discardedInput (B-332)', () => {
    it('keeps an input visible in the transcript only when the CLI (not the user) canceled it', () => {
        // never queued → visible
        expect(isTranscriptVisibleInput({ ...base, inputState: undefined })).toBe(true);
        // queued → moves to the queue overlay, not the transcript
        expect(isTranscriptVisibleInput({ ...base, inputState: 'queued' })).toBe(false);
        // web-side cancel (no reason) → the user removed it deliberately; stay hidden
        expect(isTranscriptVisibleInput({ ...base, inputState: 'canceled' })).toBe(false);
        // CLI discard (reason) → stays visible + marked
        expect(isTranscriptVisibleInput({ ...base, inputState: 'canceled', cancelReason: 'restarted' })).toBe(true);
    });

    it('maps a known reason to its key and an unknown one to generic', () => {
        expect(discardedReasonKey({ ...base, inputState: 'canceled', cancelReason: 'cleared' })).toBe('cleared');
        expect(discardedReasonKey({ ...base, inputState: 'canceled', cancelReason: 'aborted' })).toBe('aborted');
        expect(discardedReasonKey({ ...base, inputState: 'canceled', cancelReason: 'restarted' })).toBe('restarted');
        expect(discardedReasonKey({ ...base, inputState: 'canceled', cancelReason: 'future-reason' })).toBe('unknown');
        expect(discardedReasonKey({ ...base, inputState: 'canceled' })).toBe(null);
        expect(discardedReasonKey({ ...base })).toBe(null);
    });
});
