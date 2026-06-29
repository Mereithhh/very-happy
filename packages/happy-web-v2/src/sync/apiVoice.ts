import {
    VoiceConversationResponseSchema,
    VoiceUsageResponseSchema,
    type VoiceConversationResponse,
    type VoiceUsageResponse,
} from '@slopus/happy-wire';
import { AuthCredentials } from '@/auth/tokenStorage';
import { getServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';
import { config } from '@/config';

export type { VoiceConversationResponse, VoiceUsageResponse };

export async function fetchVoiceCredentials(
    credentials: AuthCredentials,
    sessionId: string
): Promise<VoiceConversationResponse> {
    const serverUrl = getServerUrl();

    const agentId = config.elevenLabsAgentId;

    if (!agentId) {
        throw new Error('Agent ID not configured');
    }

    const response = await fetch(`${serverUrl}/v1/voice/conversations`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': getHappyClientId(),
        },
        body: JSON.stringify({
            agentId
        })
    });

    if (!response.ok) {
        throw new Error(`Voice token request failed: ${response.status}`);
    }

    return VoiceConversationResponseSchema.parse(await response.json());
}

/**
 * Speech-to-text (ASR). Posts a recorded audio clip (base64) to the server,
 * which forwards it to ElevenLabs Scribe and returns the transcript. The API
 * key stays server-side. `languageCode` is optional — omitted means Scribe
 * auto-detects (handles mixed zh/en).
 */
export async function transcribeAudio(
    credentials: AuthCredentials,
    audioBase64: string,
    mimeType: string,
    languageCode?: string,
): Promise<string> {
    const serverUrl = getServerUrl();

    const response = await fetch(`${serverUrl}/v1/voice/transcribe`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': getHappyClientId(),
        },
        body: JSON.stringify({ audioBase64, mimeType, languageCode }),
    });

    if (!response.ok) {
        throw new Error(`Transcription failed: ${response.status}`);
    }

    const data = (await response.json()) as { text?: string };
    return data.text ?? '';
}

export async function fetchVoiceUsage(
    credentials: AuthCredentials
): Promise<VoiceUsageResponse> {
    const serverUrl = getServerUrl();

    const response = await fetch(`${serverUrl}/v1/voice/usage`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'X-Happy-Client': getHappyClientId(),
        },
    });

    if (!response.ok) {
        throw new Error(`Voice usage request failed: ${response.status}`);
    }

    return VoiceUsageResponseSchema.parse(await response.json());
}
