/**
 * Unit tests for the voice single-use token helpers (B-069).
 *
 * Pure parts (URL building, payload parsing) plus mintVoiceToken against an
 * injected fetch — no network. Route-level behavior (auth, 501, rate limit,
 * status mapping) lives in voiceRoutes.spec.ts.
 */
import { describe, expect, it, vi } from "vitest";
import {
    VOICE_TOKEN_TYPES,
    buildVoiceTokenUrl,
    mintVoiceToken,
    parseVoiceTokenResponse,
} from "./voiceToken";
import type { FetchLike } from "./ttsProxy";

describe("buildVoiceTokenUrl", () => {
    it("maps tts → tts_websocket", () => {
        expect(buildVoiceTokenUrl("tts")).toBe(
            "https://api.elevenlabs.io/v1/single-use-token/tts_websocket",
        );
    });

    it("maps stt → realtime_scribe", () => {
        expect(buildVoiceTokenUrl("stt")).toBe(
            "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe",
        );
    });

    it("covers every declared token type", () => {
        for (const type of Object.keys(VOICE_TOKEN_TYPES) as Array<keyof typeof VOICE_TOKEN_TYPES>) {
            expect(buildVoiceTokenUrl(type)).toContain(`/single-use-token/${VOICE_TOKEN_TYPES[type]}`);
        }
    });
});

describe("parseVoiceTokenResponse", () => {
    it("extracts the token string", () => {
        expect(parseVoiceTokenResponse({ token: "sutkn_123" })).toBe("sutkn_123");
    });

    it("rejects garbage shapes", () => {
        expect(parseVoiceTokenResponse(null)).toBeNull();
        expect(parseVoiceTokenResponse(undefined)).toBeNull();
        expect(parseVoiceTokenResponse("sutkn_123")).toBeNull();
        expect(parseVoiceTokenResponse({})).toBeNull();
        expect(parseVoiceTokenResponse({ token: "" })).toBeNull();
        expect(parseVoiceTokenResponse({ token: 42 })).toBeNull();
    });
});

describe("mintVoiceToken", () => {
    function okFetch(payload: unknown) {
        return vi.fn(async () => ({
            ok: true,
            status: 200,
            body: null,
            text: async () => "",
            json: async () => payload,
        })) as unknown as FetchLike & ReturnType<typeof vi.fn>;
    }

    it("POSTs to the single-use-token endpoint with the api key header", async () => {
        const fetchImpl = okFetch({ token: "sutkn_abc" });
        const result = await mintVoiceToken({ apiKey: "key-1", type: "tts", fetchImpl });
        expect(result).toEqual({ kind: "ok", token: "sutkn_abc" });
        expect(fetchImpl).toHaveBeenCalledWith(
            "https://api.elevenlabs.io/v1/single-use-token/tts_websocket",
            { method: "POST", headers: { "xi-api-key": "key-1" } },
        );
    });

    it("returns upstream_error with the upstream status", async () => {
        const fetchImpl = vi.fn(async () => ({
            ok: false,
            status: 401,
            body: null,
            text: async () => "bad key",
            json: async () => ({}),
        })) as unknown as FetchLike;
        const result = await mintVoiceToken({ apiKey: "key-1", type: "stt", fetchImpl });
        expect(result).toEqual({ kind: "upstream_error", status: 401, detail: "bad key" });
    });

    it("returns bad_payload when the 200 body has no token", async () => {
        const result = await mintVoiceToken({ apiKey: "k", type: "tts", fetchImpl: okFetch({ nope: 1 }) });
        expect(result).toEqual({ kind: "bad_payload" });
    });

    it("returns bad_payload when the 200 body is not JSON", async () => {
        const fetchImpl = vi.fn(async () => ({
            ok: true,
            status: 200,
            body: null,
            text: async () => "",
            json: async () => {
                throw new Error("not json");
            },
        })) as unknown as FetchLike;
        const result = await mintVoiceToken({ apiKey: "k", type: "tts", fetchImpl });
        expect(result).toEqual({ kind: "bad_payload" });
    });
});
