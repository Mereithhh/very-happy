/**
 * assistantStore transitions (B-051 review W3): the 'unsupported' TTS verdict
 * is sticky only within a conversation/visit — resetConversation and
 * resetTtsGate (screen re-entry) must clear it so an upgraded server gets a
 * fresh probe.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useAssistantStore } from './assistantStore';

describe('assistantStore TTS gate reset', () => {
    beforeEach(() => {
        useAssistantStore.setState({
            sessionId: null,
            recorderState: 'idle',
            speaking: false,
            audioUnlocked: false,
            ttsAvailability: 'unknown',
            ttsNoticeShown: false,
            lastTurnSource: null,
            lastTtsTruncated: false,
        });
    });

    it('resetConversation clears the sticky unsupported verdict and the one-shot notice', () => {
        const st = useAssistantStore.getState();
        st.setTtsAvailability('unsupported');
        st.markTtsNoticeShown();
        st.setLastTurnSource('voice');
        st.setLastTtsTruncated(true);

        useAssistantStore.getState().resetConversation();

        const after = useAssistantStore.getState();
        expect(after.ttsAvailability).toBe('unknown');
        expect(after.ttsNoticeShown).toBe(false);
        expect(after.lastTurnSource).toBeNull();
        expect(after.lastTtsTruncated).toBe(false);
        expect(after.speaking).toBe(false);
        expect(after.recorderState).toBe('idle');
    });

    it('resetTtsGate (screen re-entry) re-probes availability without touching the rest', () => {
        const st = useAssistantStore.getState();
        st.setSessionId('s-1');
        st.setTtsAvailability('unsupported');
        st.markTtsNoticeShown();

        useAssistantStore.getState().resetTtsGate();

        const after = useAssistantStore.getState();
        expect(after.ttsAvailability).toBe('unknown');
        expect(after.ttsNoticeShown).toBe(false);
        expect(after.sessionId).toBe('s-1'); // untouched
    });
});
