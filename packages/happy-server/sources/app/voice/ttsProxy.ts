//
// TTS proxy — pure helpers for the /v1/voice/tts endpoints.
//
// The routes in voiceRoutes.ts stay thin: everything decidable without I/O
// (text guardrails, request building, voices slimming, cache policy) lives
// here as pure functions, and the two upstream calls take an injected
// fetch so they are unit-testable without touching the network.
//

export const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";
// "Rachel" — ElevenLabs' stock default voice, safe fallback when the client
// doesn't pick one.
export const TTS_DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
// Flash is the current low-latency tier (~75ms, zh supported). The turbo
// family (eleven_turbo_v2_5) is deprecated upstream — don't regress to it.
export const TTS_DEFAULT_MODEL_ID = "eleven_flash_v2_5";
// Hard cap — over-length input is a 400, never silently truncated (the
// client owns any truncation strategy).
export const TTS_MAX_TEXT_CHARS = 2000;

//
// Minimal structural fetch types. The monorepo's ambient types resolve the
// global fetch to React Native's, so the routes cast `fetch` to this shape
// once and everything below stays provider-agnostic (and mockable).
//

export interface FetchLikeResponse {
    ok: boolean;
    status: number;
    /** Web ReadableStream at runtime; typed as unknown to dodge RN/Node ambient clashes. */
    body: unknown;
    text(): Promise<string>;
    json(): Promise<unknown>;
}

export type FetchLike = (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: unknown;
}) => Promise<FetchLikeResponse>;

//
// Text guardrails
//

export type TtsTextValidation = { ok: true } | { ok: false; error: string };

export function validateTtsText(text: string): TtsTextValidation {
    if (text.trim().length === 0) {
        return { ok: false, error: "Text is empty" };
    }
    if (text.length > TTS_MAX_TEXT_CHARS) {
        return { ok: false, error: `Text too long (max ${TTS_MAX_TEXT_CHARS} chars)` };
    }
    return { ok: true };
}

//
// TTS stream proxy
//

export function buildTtsRequest(opts: { text: string; voiceId?: string; modelId?: string }): {
    url: string;
    body: { text: string; model_id: string };
} {
    const voiceId = opts.voiceId || TTS_DEFAULT_VOICE_ID;
    const modelId = opts.modelId || TTS_DEFAULT_MODEL_ID;
    return {
        url: `${ELEVENLABS_API_BASE}/text-to-speech/${encodeURIComponent(voiceId)}/stream`,
        body: { text: opts.text, model_id: modelId },
    };
}

export type TtsProxyResult =
    | { kind: "stream"; body: unknown }
    | { kind: "upstream_error"; status: number; detail: string };

export async function proxyTts(opts: {
    apiKey: string;
    text: string;
    voiceId?: string;
    modelId?: string;
    signal?: unknown;
    fetchImpl: FetchLike;
}): Promise<TtsProxyResult> {
    const { url, body } = buildTtsRequest(opts);
    const res = await opts.fetchImpl(url, {
        method: "POST",
        headers: {
            "xi-api-key": opts.apiKey,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: opts.signal,
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        return { kind: "upstream_error", status: res.status, detail };
    }
    return { kind: "stream", body: res.body };
}

//
// Voices list — slim mapping + fetch
//

export interface SlimVoice {
    voiceId: string;
    name: string;
    previewUrl: string;
    labels?: Record<string, string>;
}

function slimLabels(raw: unknown): Record<string, string> | undefined {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const out: Record<string, string> = {};
    let any = false;
    for (const [key, value] of Object.entries(raw)) {
        if (typeof value === "string") {
            out[key] = value;
            any = true;
        }
    }
    return any ? out : undefined;
}

/** Map ElevenLabs' GET /v1/voices payload down to the slim client shape. Defensive: garbage in → []. */
export function slimVoices(raw: unknown): SlimVoice[] {
    if (typeof raw !== "object" || raw === null) return [];
    const list = (raw as { voices?: unknown }).voices;
    if (!Array.isArray(list)) return [];
    const out: SlimVoice[] = [];
    for (const item of list) {
        if (typeof item !== "object" || item === null) continue;
        const v = item as { voice_id?: unknown; name?: unknown; preview_url?: unknown; labels?: unknown };
        if (typeof v.voice_id !== "string" || v.voice_id.length === 0) continue;
        const voice: SlimVoice = {
            voiceId: v.voice_id,
            name: typeof v.name === "string" ? v.name : v.voice_id,
            previewUrl: typeof v.preview_url === "string" ? v.preview_url : "",
        };
        const labels = slimLabels(v.labels);
        if (labels) voice.labels = labels;
        out.push(voice);
    }
    return out;
}

export async function fetchSlimVoices(opts: {
    apiKey: string;
    fetchImpl: FetchLike;
}): Promise<{ ok: true; voices: SlimVoice[] } | { ok: false; status: number }> {
    const res = await opts.fetchImpl(`${ELEVENLABS_API_BASE}/voices`, {
        headers: { "xi-api-key": opts.apiKey },
    });
    if (!res.ok) {
        return { ok: false, status: res.status };
    }
    const data = await res.json().catch(() => null);
    return { ok: true, voices: slimVoices(data) };
}

//
// Timed cache — module-level single-value cache with TTL (single-instance
// deployment; `now` is injectable for tests).
//

export interface TimedCache<T> {
    get(now?: number): T | null;
    set(value: T, now?: number): void;
}

export function createTimedCache<T>(ttlMs: number): TimedCache<T> {
    let entry: { value: T; at: number } | null = null;
    return {
        get(now: number = Date.now()): T | null {
            if (entry === null) return null;
            if (now - entry.at >= ttlMs) {
                entry = null;
                return null;
            }
            return entry.value;
        },
        set(value: T, now: number = Date.now()): void {
            entry = { value, at: now };
        },
    };
}
