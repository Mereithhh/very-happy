//
// Voice single-use token minting — pure helpers for POST /v1/voice/token.
//
// B-069 streaming voice: the browser opens WebSocket connections DIRECTLY to
// ElevenLabs (TTS stream-input + realtime STT). It authenticates those
// sockets with a single-use token minted here — the API key itself never
// leaves the server. Same school as ttsProxy.ts: everything decidable
// without I/O is a pure function, the one upstream call takes an injected
// fetch so it is unit-testable without touching the network.
//

import { ELEVENLABS_API_BASE, type FetchLike } from "./ttsProxy";

/**
 * Client-facing token kinds → ElevenLabs single-use token types.
 * (POST /v1/single-use-token/{token_type}; tokens are one-shot, 15 min TTL.)
 */
export const VOICE_TOKEN_TYPES = {
    tts: "tts_websocket",
    stt: "realtime_scribe",
} as const;

export type VoiceTokenType = keyof typeof VOICE_TOKEN_TYPES;

export function buildVoiceTokenUrl(type: VoiceTokenType): string {
    return `${ELEVENLABS_API_BASE}/single-use-token/${VOICE_TOKEN_TYPES[type]}`;
}

/**
 * Extract the token string from ElevenLabs' response payload.
 * Defensive: any unexpected shape → null (caller answers 502).
 */
export function parseVoiceTokenResponse(raw: unknown): string | null {
    if (typeof raw !== "object" || raw === null) return null;
    const token = (raw as { token?: unknown }).token;
    if (typeof token !== "string" || token.length === 0) return null;
    return token;
}

export type VoiceTokenResult =
    | { kind: "ok"; token: string }
    | { kind: "upstream_error"; status: number; detail: string }
    | { kind: "bad_payload" };

export async function mintVoiceToken(opts: {
    apiKey: string;
    type: VoiceTokenType;
    fetchImpl: FetchLike;
}): Promise<VoiceTokenResult> {
    const res = await opts.fetchImpl(buildVoiceTokenUrl(opts.type), {
        method: "POST",
        headers: { "xi-api-key": opts.apiKey },
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        return { kind: "upstream_error", status: res.status, detail };
    }
    const data = await res.json().catch(() => null);
    const token = parseVoiceTokenResponse(data);
    if (token === null) return { kind: "bad_payload" };
    return { kind: "ok", token };
}
