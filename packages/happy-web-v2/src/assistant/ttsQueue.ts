/**
 * TTS playback queue semantics (pure, unit-tested).
 *
 * The player (ttsPlayer.ts) owns AudioContext/BufferSource side effects; this
 * module owns the ordering rules: FIFO playback, dedupe by utterance id
 * (a message must never be read twice even if the subscription re-delivers
 * it), and a stop that clears everything.
 */

export interface TtsUtterance {
    /** stable id — the message id; dedupe key */
    id: string;
    text: string;
}

export interface TtsQueueState {
    /** utterances waiting to be synthesized+played, oldest first */
    queue: TtsUtterance[];
    /** id currently being synthesized or played, null when idle */
    playingId: string | null;
    /** every id ever enqueued (dedupe memory for the session) */
    seen: ReadonlySet<string>;
}

export const ttsQueueInitial: TtsQueueState = {
    queue: [],
    playingId: null,
    seen: new Set<string>(),
};

/** Enqueue an utterance; ids already seen (queued, playing, or played) are dropped. */
export function ttsEnqueue(state: TtsQueueState, utterance: TtsUtterance): TtsQueueState {
    if (state.seen.has(utterance.id)) return state;
    const seen = new Set(state.seen);
    seen.add(utterance.id);
    return { ...state, queue: [...state.queue, utterance], seen };
}

/**
 * Take the next utterance to play. Returns the unchanged state when something
 * is already playing or the queue is empty.
 */
export function ttsStartNext(state: TtsQueueState): { state: TtsQueueState; next: TtsUtterance | null } {
    if (state.playingId !== null || state.queue.length === 0) {
        return { state, next: null };
    }
    const [next, ...rest] = state.queue;
    return { state: { ...state, queue: rest, playingId: next.id }, next };
}

/** Current utterance finished (or failed) — clear playingId; caller loops startNext. */
export function ttsFinishCurrent(state: TtsQueueState): TtsQueueState {
    if (state.playingId === null) return state;
    return { ...state, playingId: null };
}

/**
 * Stop everything (leave screen / new conversation): drop pending utterances
 * and the playing marker, but KEEP the seen-set — stopping must not cause old
 * messages to be re-read if they get re-delivered afterwards.
 */
export function ttsStopAll(state: TtsQueueState): TtsQueueState {
    if (state.queue.length === 0 && state.playingId === null) return state;
    return { ...state, queue: [], playingId: null };
}

/** True while an utterance is being synthesized or played. */
export function ttsIsActive(state: TtsQueueState): boolean {
    return state.playingId !== null || state.queue.length > 0;
}
