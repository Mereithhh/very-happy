/**
 * Push-to-talk recorder state machine (pure, unit-tested).
 *
 * The hook (useHoldToTalk) owns the MediaRecorder/stream side effects; every
 * decision — what a pointerup means, whether a clip is a mis-tap, what to do
 * when the tab hides mid-recording — lives here so it can be tested without
 * a browser. Effects are returned as data and executed by the caller.
 */

import { MIN_HOLD_MS } from './assistantConstants';

export type RecorderState = 'idle' | 'recording' | 'transcribing';

export type RecorderEvent =
    /** pointerdown on the PTT button */
    | { type: 'press'; at: number }
    /** pointerup — a normal release */
    | { type: 'release'; at: number }
    /** pointercancel / visibilitychange-hidden / track muted / getUserMedia failed */
    | { type: 'cancel' }
    /** transcription finished (text may be empty → nothing to send) */
    | { type: 'transcribed'; text: string }
    | { type: 'transcribe-failed' };

export type RecorderEffect =
    /** acquire mic + start a NEW MediaRecorder */
    | { kind: 'start-recording' }
    /** stop the recorder, keep the clip, run STT on it */
    | { kind: 'stop-and-transcribe' }
    /** stop the recorder and throw the clip away */
    | { kind: 'discard-recording' }
    /** hand the transcript to the send pipeline */
    | { kind: 'send-text'; text: string };

export interface RecorderSnapshot {
    state: RecorderState;
    /** timestamp of the press that started the current recording (recording only) */
    pressedAt: number | null;
}

export const recorderInitial: RecorderSnapshot = { state: 'idle', pressedAt: null };

export function recorderTransition(
    snap: RecorderSnapshot,
    event: RecorderEvent,
): { next: RecorderSnapshot; effects: RecorderEffect[] } {
    switch (snap.state) {
        case 'idle': {
            if (event.type === 'press') {
                return {
                    next: { state: 'recording', pressedAt: event.at },
                    effects: [{ kind: 'start-recording' }],
                };
            }
            return { next: snap, effects: [] };
        }
        case 'recording': {
            if (event.type === 'release') {
                const held = event.at - (snap.pressedAt ?? event.at);
                if (held < MIN_HOLD_MS) {
                    // Mis-tap: too short to be speech — discard silently.
                    return {
                        next: recorderInitial,
                        effects: [{ kind: 'discard-recording' }],
                    };
                }
                return {
                    next: { state: 'transcribing', pressedAt: null },
                    effects: [{ kind: 'stop-and-transcribe' }],
                };
            }
            if (event.type === 'cancel') {
                return {
                    next: recorderInitial,
                    effects: [{ kind: 'discard-recording' }],
                };
            }
            // A second press while already recording is impossible from one
            // pointer; ignore anything else.
            return { next: snap, effects: [] };
        }
        case 'transcribing': {
            if (event.type === 'transcribed') {
                const text = event.text.trim();
                return {
                    next: recorderInitial,
                    effects: text ? [{ kind: 'send-text', text }] : [],
                };
            }
            if (event.type === 'transcribe-failed' || event.type === 'cancel') {
                return { next: recorderInitial, effects: [] };
            }
            // Presses during transcription are dropped (no queuing) — the
            // button is visually disabled in that state anyway.
            return { next: snap, effects: [] };
        }
    }
}

/** Preference order per the iOS/Android/desktop support matrix. */
export const RECORDER_MIME_CANDIDATES = [
    'audio/webm;codecs=opus',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
] as const;

/**
 * Pick the first supported MIME type; null means "construct MediaRecorder
 * with no options and read back recorder.mimeType". `isSupported` is injected
 * so the probe is testable (and safe when MediaRecorder.isTypeSupported is
 * itself missing).
 */
export function pickRecorderMime(isSupported: (mime: string) => boolean): string | null {
    for (const mime of RECORDER_MIME_CANDIDATES) {
        try {
            if (isSupported(mime)) return mime;
        } catch {
            // treat a throwing probe as unsupported
        }
    }
    return null;
}
