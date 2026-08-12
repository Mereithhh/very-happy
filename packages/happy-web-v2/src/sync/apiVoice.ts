import {
    VoiceConversationResponseSchema,
    VoiceUsageResponseSchema,
    type VoiceConversationResponse,
    type VoiceUsageResponse,
} from '@slopus/happy-wire';
import { AuthCredentials } from '@/auth/tokenStorage';
import { getServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';
import { classifyTtsErrorStatus } from './ttsStatus';
import { config } from '@/config';

export type { VoiceConversationResponse, VoiceUsageResponse };

export async function fetchVoiceCredentials(
    credentials: AuthCredentials,
    _sessionId: string
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

// ── Assistant TTS (B-051) ───────────────────────────────────────────────────
// Raw fetch on purpose (same as the rest of this file): the server PASSES
// THROUGH upstream status codes, so a 401/403 here can mean "ElevenLabs key
// invalid", NOT "Happy login expired". These helpers must consume every error
// locally and never feed any global auth/logout handling. They return
// discriminated results instead of throwing.

export type TtsSynthesisResult =
    | { kind: 'ok'; data: ArrayBuffer }
    /** 404/501 — server not upgraded / voice not configured → pure-text mode */
    | { kind: 'unsupported'; status: number }
    /** 429 — rate limited (60/min); skip this utterance, keep voice mode */
    | { kind: 'rate-limited' }
    /** anything else (400 bad text, upstream 502, 5xx, network) */
    | { kind: 'error'; status?: number };

export async function synthesizeSpeech(
    credentials: AuthCredentials,
    text: string,
    options?: { voiceId?: string; modelId?: string },
): Promise<TtsSynthesisResult> {
    const serverUrl = getServerUrl();
    try {
        const response = await fetch(`${serverUrl}/v1/voice/tts`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getHappyClientId(),
            },
            body: JSON.stringify({
                text,
                ...(options?.voiceId ? { voiceId: options.voiceId } : {}),
                ...(options?.modelId ? { modelId: options.modelId } : {}),
            }),
        });
        if (response.ok) {
            return { kind: 'ok', data: await response.arrayBuffer() };
        }
        const kind = classifyTtsErrorStatus(response.status);
        if (kind === 'unsupported') return { kind: 'unsupported', status: response.status };
        if (kind === 'rate-limited') return { kind: 'rate-limited' };
        return { kind: 'error', status: response.status };
    } catch {
        return { kind: 'error' };
    }
}

export interface TtsVoice {
    voiceId: string;
    name: string;
    previewUrl?: string;
    labels?: Record<string, string>;
}

export type TtsVoicesResult =
    | { kind: 'ok'; voices: TtsVoice[] }
    | { kind: 'unsupported'; status: number }
    | { kind: 'error'; status?: number };

export async function fetchTtsVoices(credentials: AuthCredentials): Promise<TtsVoicesResult> {
    const serverUrl = getServerUrl();
    try {
        const response = await fetch(`${serverUrl}/v1/voice/tts/voices`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'X-Happy-Client': getHappyClientId(),
            },
        });
        if (response.ok) {
            const data = (await response.json()) as { voices?: TtsVoice[] };
            return { kind: 'ok', voices: Array.isArray(data.voices) ? data.voices : [] };
        }
        if (classifyTtsErrorStatus(response.status) === 'unsupported') {
            return { kind: 'unsupported', status: response.status };
        }
        return { kind: 'error', status: response.status };
    } catch {
        return { kind: 'error' };
    }
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
