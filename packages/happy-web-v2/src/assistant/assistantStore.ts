/**
 * assistantStore — UI state for the /assistant voice form (B-051).
 *
 * Independent zustand store (clipboardHistoryStore precedent: feature state
 * stays out of the giant sync storage store). Deliberately NOT persisted:
 * the audio unlock is per-page-load by platform rule (iOS), and everything
 * else is derivable or transient.
 *
 * We do NOT reuse storage.realtimeMode: that slot belongs to the legacy
 * ElevenLabs realtime shim (own debounce + producers). Wiring a second
 * producer into it would couple two lifecycles for zero gain — the assistant
 * keeps its own state machine here.
 */

import { create } from 'zustand';

export type AssistantRecorderUiState = 'idle' | 'recording' | 'transcribing';

/** Overall animation state for the central logo. */
export type AssistantVoiceState = 'idle' | 'recording' | 'transcribing' | 'waiting' | 'speaking';

/** TTS availability as learned from the server at runtime. */
export type TtsAvailability = 'unknown' | 'available' | 'unsupported';

interface AssistantStoreState {
    /** the assistant session currently attached to (null = not resolved yet) */
    sessionId: string | null;
    /** recorder substate mirrored from the recorder machine */
    recorderState: AssistantRecorderUiState;
    /** an assistant reply is being synthesized/played */
    speaking: boolean;
    /** B-059 captions: text of the utterance currently being spoken */
    speakingText: string | null;
    /** iOS/Safari audio unlock done for this page load (memory only) */
    audioUnlocked: boolean;
    /** 404/501 from the TTS endpoint → degrade to pure text */
    ttsAvailability: TtsAvailability;
    /** one-shot "voice unavailable, text only" notice already shown */
    ttsNoticeShown: boolean;
    /** how the latest user turn was produced (drives read-aloud policy) */
    lastTurnSource: 'voice' | 'text' | null;
    /** the reply currently/last spoken was truncated for TTS */
    lastTtsTruncated: boolean;

    setSessionId: (id: string | null) => void;
    setRecorderState: (s: AssistantRecorderUiState) => void;
    setSpeaking: (v: boolean) => void;
    setSpeakingText: (t: string | null) => void;
    setAudioUnlocked: (v: boolean) => void;
    setTtsAvailability: (v: TtsAvailability) => void;
    markTtsNoticeShown: () => void;
    setLastTurnSource: (v: 'voice' | 'text') => void;
    setLastTtsTruncated: (v: boolean) => void;
    /**
     * Re-probe TTS availability (entering the screen / new conversation):
     * the 'unsupported' verdict is sticky ONLY within a visit — the server may
     * have been upgraded/configured since, so each visit gets a fresh chance.
     */
    resetTtsGate: () => void;
    /** "new conversation": clear per-conversation transients */
    resetConversation: () => void;
}

export const useAssistantStore = create<AssistantStoreState>((set) => ({
    sessionId: null,
    recorderState: 'idle',
    speaking: false,
    speakingText: null,
    audioUnlocked: false,
    ttsAvailability: 'unknown',
    ttsNoticeShown: false,
    lastTurnSource: null,
    lastTtsTruncated: false,

    setSessionId: (id) => set({ sessionId: id }),
    setRecorderState: (s) => set({ recorderState: s }),
    setSpeaking: (v) => set({ speaking: v }),
    setSpeakingText: (t) => set({ speakingText: t }),
    setAudioUnlocked: (v) => set({ audioUnlocked: v }),
    setTtsAvailability: (v) => set({ ttsAvailability: v }),
    markTtsNoticeShown: () => set({ ttsNoticeShown: true }),
    setLastTurnSource: (v) => set({ lastTurnSource: v }),
    setLastTtsTruncated: (v) => set({ lastTtsTruncated: v }),
    resetTtsGate: () => set({ ttsAvailability: 'unknown', ttsNoticeShown: false }),
    resetConversation: () =>
        set({
            lastTurnSource: null,
            lastTtsTruncated: false,
            recorderState: 'idle',
            speaking: false,
            speakingText: null,
            ttsAvailability: 'unknown',
            ttsNoticeShown: false,
        }),
}));

/**
 * Compose the logo animation state. Priority: what the user is doing
 * (recording) beats what the machine is doing; speaking beats waiting so the
 * ring hands over cleanly when a reply starts mid-thought.
 */
export function deriveVoiceState(
    recorder: AssistantRecorderUiState,
    speaking: boolean,
    thinking: boolean,
): AssistantVoiceState {
    if (recorder === 'recording') return 'recording';
    if (recorder === 'transcribing') return 'transcribing';
    if (speaking) return 'speaking';
    if (thinking) return 'waiting';
    return 'idle';
}
