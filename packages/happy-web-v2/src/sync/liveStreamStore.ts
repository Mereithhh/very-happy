/**
 * liveStreamStore — device-local, non-persisted home for session drafts
 * (B-309). See `liveStream.ts` for the state transitions; this file owns only
 * the store, the socket entry point, and the sweep timer.
 *
 * Kept OUT of `storage` deliberately. Drafts change ~12 times a second while a
 * turn runs; putting them in the session store would make every message,
 * tool card and header in the transcript re-render at that rate. Subscribers
 * here are the two components that actually show a draft.
 */

import { create } from 'zustand';
import { parseSessionStreamFrame } from '@slopus/happy-wire';
import type { Encryption } from '@/sync/encryption/encryption';
import {
    applyStreamFrame,
    claimStreamKeys,
    DRAFT_MAX_AGE_MS,
    DRAFT_SWEEP_DELAY_MS,
    EMPTY_LIVE_STREAM,
    sweepDrafts,
    type LiveStreamProgress,
    type LiveStreamState,
} from '@/sync/liveStream';

export interface SessionStreamEvent {
    sessionId?: string;
    payload: string;
    enc?: boolean;
}

interface LiveStreamStore {
    streams: Record<string, LiveStreamState>;
    ingest: (sessionId: string, frame: Parameters<typeof applyStreamFrame>[1]) => void;
    claim: (sessionId: string, keys: readonly string[]) => void;
    sweep: (sessionId: string) => void;
    endTurn: (sessionId: string) => void;
    clear: (sessionId: string) => void;
}

export const useLiveStreamStore = create<LiveStreamStore>((set, get) => ({
    streams: {},
    ingest: (sessionId, frame) => {
        const now = Date.now();
        set((state) => {
            const streams: Record<string, LiveStreamState> = {};
            // Opportunistic reaping. The max-age backstop in `sweepDrafts` is
            // otherwise unreachable: the only scheduled sweep is armed by
            // `turn-end`, which is exactly the frame a CLI killed mid-turn
            // never sends. Every frame for any session is a chance to drop the
            // ones that went silent — cheap, since a user has a handful of
            // sessions, and it needs no global timer.
            for (const [id, stream] of Object.entries(state.streams)) {
                if (id === sessionId || now - stream.updatedAt < DRAFT_MAX_AGE_MS) streams[id] = stream;
            }
            streams[sessionId] = applyStreamFrame(state.streams[sessionId], frame, now);
            return { streams };
        });
        if (frame.t === 'turn-end') scheduleSweep(sessionId, get);
    },
    claim: (sessionId, keys) => {
        set((state) => {
            const previous = state.streams[sessionId];
            if (!previous) return state;
            const next = claimStreamKeys(previous, keys);
            if (next === previous) return state;
            const streams = { ...state.streams, [sessionId]: next! };
            return { streams };
        });
    },
    sweep: (sessionId) => {
        set((state) => {
            const previous = state.streams[sessionId];
            if (!previous) return state;
            const next = sweepDrafts(previous, Date.now());
            if (next === previous) return state;
            const streams = { ...state.streams };
            if (next) streams[sessionId] = next;
            else delete streams[sessionId];
            return { streams };
        });
    },
    /** Arm the sweep without a frame — used when the session stops being live
     *  but the CLI never got to send `turn-end` (killed, crashed, offline).
     *  Deliberately the SAME delayed sweep rather than an immediate clear:
     *  liveness drops the moment the turn ends, while the persisted message is
     *  still in flight, so clearing now would blank the tail of the transcript
     *  for the length of that trip. */
    endTurn: (sessionId) => {
        const state = get();
        if (!state.streams[sessionId]) return;
        state.ingest(sessionId, { t: 'turn-end' });
    },
    clear: (sessionId) => {
        set((state) => {
            if (!state.streams[sessionId]) return state;
            const streams = { ...state.streams };
            delete streams[sessionId];
            return { streams };
        });
    },
}));

const sweepTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleSweep(sessionId: string, get: () => LiveStreamStore) {
    const existing = sweepTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    sweepTimers.set(sessionId, setTimeout(() => {
        sweepTimers.delete(sessionId);
        get().sweep(sessionId);
    }, DRAFT_SWEEP_DELAY_MS));
}

/**
 * Entry point wired to `apiSocket.onMessage('session-stream', …)`.
 *
 * Unlike clipboard-push this does NOT wait for the session key to appear: a
 * draft is worthless by the time a 12-second key wait resolves. No key yet
 * simply means the first frames of a turn are skipped, and the persisted
 * message still lands normally.
 */
export async function handleSessionStream(encryption: Encryption, data: unknown): Promise<void> {
    const event = data as SessionStreamEvent | null;
    if (!event || typeof event.payload !== 'string' || !event.sessionId) return;
    if (!event.enc) return;

    const decryptor = encryption.getSessionEncryption(event.sessionId);
    if (!decryptor) return;

    let parsed: unknown;
    try {
        // decryptRaw already JSON-parses; the producer hands `encrypt` the
        // frame object rather than a string, so there is nothing left to parse.
        parsed = await decryptor.decryptRaw(event.payload);
    } catch {
        // A frame we cannot read is a frame we drop — never a thrown error on
        // the socket path.
        return;
    }

    const frame = parseSessionStreamFrame(parsed);
    if (!frame) return;
    useLiveStreamStore.getState().ingest(event.sessionId, frame);
}

/** Drop drafts the persisted messages in this batch have superseded. */
export function claimLiveStreamKeys(sessionId: string, keys: readonly string[]): void {
    if (keys.length === 0) return;
    useLiveStreamStore.getState().claim(sessionId, keys);
}

/** Subscribe to one session's draft. Returns a stable empty state when idle.
 *
 *  No `useShallow`: `updatedAt` moves on every frame, so a shallow compare
 *  would never report equal and only cost a key walk per render. */
export function useLiveStream(sessionId: string): LiveStreamState {
    return useLiveStreamStore((state) => state.streams[sessionId] ?? EMPTY_LIVE_STREAM);
}

/** Subscribe to just the quantified progress. Its identity is preserved
 *  across delta frames, so the status bar re-renders on real progress
 *  changes instead of ~12 times a second. */
export function useLiveStreamProgress(sessionId: string): LiveStreamProgress {
    return useLiveStreamStore((state) => (state.streams[sessionId] ?? EMPTY_LIVE_STREAM).progress);
}

/** Arm the delayed sweep for a session that stopped being live. */
export function endLiveStreamTurn(sessionId: string): void {
    useLiveStreamStore.getState().endTurn(sessionId);
}
