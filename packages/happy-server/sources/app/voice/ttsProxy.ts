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

/**
 * Map an upstream (ElevenLabs) error status to the status WE answer with.
 * Never pass the upstream code through verbatim: the web client feature-
 * detects these endpoints by response status (a 404 means "this server has
 * no TTS route yet" and permanently degrades the feature), so an upstream
 * 404/401/… must not masquerade as ours. 429 keeps its rate-limit meaning;
 * everything else is a plain gateway failure.
 */
export function upstreamErrorReplyStatus(upstreamStatus: number): 429 | 502 {
    return upstreamStatus === 429 ? 429 : 502;
}

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
// Shared voice library (ElevenLabs Voice Library) — language whitelist,
// request building, slim mapping, and the "add to my voices" call.
// Verified against the official docs (2026-08):
//   GET  /v1/shared-voices?language=&page_size=&sort=…   → { voices, has_more, … }
//   POST /v1/voices/add/{public_user_id}/{voice_id}      body { new_name } → { voice_id }
//

export const SHARED_VOICES_LANGS = ["zh", "en", "ja", "ko"] as const;
export type SharedVoicesLang = (typeof SHARED_VOICES_LANGS)[number];
export const SHARED_VOICES_PAGE_SIZE = 30;

/**
 * Whitelist parse for the ?lang= query. Missing/empty → default "zh"
 * (the feature exists for Chinese voices first); anything not on the
 * whitelist → null, the route answers 400.
 */
export function parseSharedVoicesLang(raw: string | undefined): SharedVoicesLang | null {
    if (raw === undefined || raw === "") return "zh";
    return (SHARED_VOICES_LANGS as readonly string[]).includes(raw)
        ? (raw as SharedVoicesLang)
        : null;
}

/** Most-used voices first — `sort=usage_character_count_1y` per the docs' sort enum. */
export function buildSharedVoicesUrl(lang: SharedVoicesLang): string {
    const params = new URLSearchParams({
        language: lang,
        page_size: String(SHARED_VOICES_PAGE_SIZE),
        sort: "usage_character_count_1y",
    });
    return `${ELEVENLABS_API_BASE}/shared-voices?${params.toString()}`;
}

export interface SlimSharedVoice {
    publicUserId: string;
    voiceId: string;
    name: string;
    previewUrl: string;
    labels?: Record<string, string>;
    description?: string;
}

// Shared-voice items carry flat descriptor fields instead of a labels object;
// fold the human-meaningful ones into the same labels shape the account
// voices use so the client renders both lists identically.
const SHARED_VOICE_LABEL_FIELDS = ["gender", "age", "accent", "descriptive", "use_case"] as const;

/** Map ElevenLabs' GET /v1/shared-voices payload down to the slim client shape. Defensive: garbage in → []. */
export function slimSharedVoices(raw: unknown): SlimSharedVoice[] {
    if (typeof raw !== "object" || raw === null) return [];
    const list = (raw as { voices?: unknown }).voices;
    if (!Array.isArray(list)) return [];
    const out: SlimSharedVoice[] = [];
    for (const item of list) {
        if (typeof item !== "object" || item === null) continue;
        const v = item as Record<string, unknown>;
        if (typeof v.voice_id !== "string" || v.voice_id.length === 0) continue;
        if (typeof v.public_owner_id !== "string" || v.public_owner_id.length === 0) continue;
        const voice: SlimSharedVoice = {
            publicUserId: v.public_owner_id,
            voiceId: v.voice_id,
            name: typeof v.name === "string" ? v.name : v.voice_id,
            previewUrl: typeof v.preview_url === "string" ? v.preview_url : "",
        };
        const labels: Record<string, string> = {};
        let anyLabel = false;
        for (const field of SHARED_VOICE_LABEL_FIELDS) {
            const value = v[field];
            if (typeof value === "string" && value.length > 0) {
                labels[field] = value;
                anyLabel = true;
            }
        }
        if (anyLabel) voice.labels = labels;
        if (typeof v.description === "string" && v.description.length > 0) {
            voice.description = v.description;
        }
        out.push(voice);
    }
    return out;
}

export async function fetchSlimSharedVoices(opts: {
    apiKey: string;
    lang: SharedVoicesLang;
    fetchImpl: FetchLike;
}): Promise<{ ok: true; voices: SlimSharedVoice[] } | { ok: false; status: number }> {
    const res = await opts.fetchImpl(buildSharedVoicesUrl(opts.lang), {
        headers: { "xi-api-key": opts.apiKey },
    });
    if (!res.ok) {
        return { ok: false, status: res.status };
    }
    const data = await res.json().catch(() => null);
    return { ok: true, voices: slimSharedVoices(data) };
}

export function buildAddSharedVoiceRequest(opts: { publicUserId: string; voiceId: string; name: string }): {
    url: string;
    body: { new_name: string };
} {
    return {
        url: `${ELEVENLABS_API_BASE}/voices/add/${encodeURIComponent(opts.publicUserId)}/${encodeURIComponent(opts.voiceId)}`,
        body: { new_name: opts.name },
    };
}

/**
 * Add a shared voice to the account. On 2xx the upstream answers
 * { voice_id }; a malformed 2xx body still counts as success with the
 * requested voiceId (the voice WAS added — don't fail the client).
 */
export async function addSharedVoice(opts: {
    apiKey: string;
    publicUserId: string;
    voiceId: string;
    name: string;
    fetchImpl: FetchLike;
}): Promise<{ ok: true; voiceId: string } | { ok: false; status: number; detail: string }> {
    const { url, body } = buildAddSharedVoiceRequest(opts);
    const res = await opts.fetchImpl(url, {
        method: "POST",
        headers: {
            "xi-api-key": opts.apiKey,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        return { ok: false, status: res.status, detail };
    }
    const data = (await res.json().catch(() => null)) as { voice_id?: unknown } | null;
    const voiceId = typeof data?.voice_id === "string" && data.voice_id.length > 0
        ? data.voice_id
        : opts.voiceId;
    return { ok: true, voiceId };
}

//
// Timed cache — module-level single-value cache with TTL (single-instance
// deployment; `now` is injectable for tests).
//

export interface TimedCache<T> {
    get(now?: number): T | null;
    set(value: T, now?: number): void;
    /** Drop the entry immediately (e.g. after a mutation invalidates it). */
    clear(): void;
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
        clear(): void {
            entry = null;
        },
    };
}

//
// Keyed timed cache — same policy as createTimedCache but with one slot per
// key (the shared-voices list is cached per language).
//

export interface KeyedTimedCache<T> {
    get(key: string, now?: number): T | null;
    set(key: string, value: T, now?: number): void;
}

export function createKeyedTimedCache<T>(ttlMs: number): KeyedTimedCache<T> {
    const entries = new Map<string, { value: T; at: number }>();
    return {
        get(key: string, now: number = Date.now()): T | null {
            const entry = entries.get(key);
            if (entry === undefined) return null;
            if (now - entry.at >= ttlMs) {
                entries.delete(key);
                return null;
            }
            return entry.value;
        },
        set(key: string, value: T, now: number = Date.now()): void {
            entries.set(key, { value, at: now });
        },
    };
}
