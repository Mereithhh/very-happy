import { describe, it, expect } from 'vitest';
import {
    recorderInitial,
    recorderTransition,
    pickRecorderMime,
    RECORDER_MIME_CANDIDATES,
    type RecorderSnapshot,
} from './recorderMachine';
import { MIN_HOLD_MS } from './assistantConstants';

describe('recorderTransition', () => {
    it('press starts recording', () => {
        const { next, effects } = recorderTransition(recorderInitial, { type: 'press', at: 1000 });
        expect(next).toEqual({ state: 'recording', pressedAt: 1000 });
        expect(effects).toEqual([{ kind: 'start-recording' }]);
    });

    it('short release (< MIN_HOLD_MS) discards as a mis-tap', () => {
        const rec: RecorderSnapshot = { state: 'recording', pressedAt: 1000 };
        const { next, effects } = recorderTransition(rec, { type: 'release', at: 1000 + MIN_HOLD_MS - 1 });
        expect(next).toEqual(recorderInitial);
        expect(effects).toEqual([{ kind: 'discard-recording' }]);
    });

    it('long release stops and transcribes', () => {
        const rec: RecorderSnapshot = { state: 'recording', pressedAt: 1000 };
        const { next, effects } = recorderTransition(rec, { type: 'release', at: 1000 + MIN_HOLD_MS });
        expect(next.state).toBe('transcribing');
        expect(effects).toEqual([{ kind: 'stop-and-transcribe' }]);
    });

    it('cancel during recording (pointercancel / hidden / muted) discards', () => {
        const rec: RecorderSnapshot = { state: 'recording', pressedAt: 1000 };
        const { next, effects } = recorderTransition(rec, { type: 'cancel' });
        expect(next).toEqual(recorderInitial);
        expect(effects).toEqual([{ kind: 'discard-recording' }]);
    });

    it('transcribed with text sends it and returns to idle', () => {
        const t: RecorderSnapshot = { state: 'transcribing', pressedAt: null };
        const { next, effects } = recorderTransition(t, { type: 'transcribed', text: ' hello ' });
        expect(next).toEqual(recorderInitial);
        expect(effects).toEqual([{ kind: 'send-text', text: 'hello' }]);
    });

    it('transcribed with empty/whitespace text sends nothing', () => {
        const t: RecorderSnapshot = { state: 'transcribing', pressedAt: null };
        const { next, effects } = recorderTransition(t, { type: 'transcribed', text: '   ' });
        expect(next).toEqual(recorderInitial);
        expect(effects).toEqual([]);
    });

    it('transcribe failure returns to idle without effects', () => {
        const t: RecorderSnapshot = { state: 'transcribing', pressedAt: null };
        const { next, effects } = recorderTransition(t, { type: 'transcribe-failed' });
        expect(next).toEqual(recorderInitial);
        expect(effects).toEqual([]);
    });

    it('press during transcription is dropped (no queueing)', () => {
        const t: RecorderSnapshot = { state: 'transcribing', pressedAt: null };
        const { next, effects } = recorderTransition(t, { type: 'press', at: 5000 });
        expect(next).toEqual(t);
        expect(effects).toEqual([]);
    });

    it('release/cancel in idle are no-ops', () => {
        expect(recorderTransition(recorderInitial, { type: 'release', at: 1 }).effects).toEqual([]);
        expect(recorderTransition(recorderInitial, { type: 'cancel' }).effects).toEqual([]);
    });
});

describe('pickRecorderMime', () => {
    it('returns the first supported candidate in preference order', () => {
        expect(pickRecorderMime((m) => m === 'audio/mp4')).toBe('audio/mp4');
        expect(pickRecorderMime(() => true)).toBe(RECORDER_MIME_CANDIDATES[0]);
    });

    it('prefers webm/opus over mp4 when both supported', () => {
        const supported = new Set(['audio/webm;codecs=opus', 'audio/mp4']);
        expect(pickRecorderMime((m) => supported.has(m))).toBe('audio/webm;codecs=opus');
    });

    it('returns null when nothing is supported (caller omits options)', () => {
        expect(pickRecorderMime(() => false)).toBeNull();
    });

    it('treats a throwing probe as unsupported', () => {
        expect(
            pickRecorderMime(() => {
                throw new Error('no MediaRecorder');
            }),
        ).toBeNull();
    });
});
