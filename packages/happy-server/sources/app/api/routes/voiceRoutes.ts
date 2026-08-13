import { z } from "zod";
import * as crypto from "crypto";
import { Readable } from "node:stream";
import { VoiceConversationResponseSchema, VoiceUsageResponseSchema } from "@slopus/happy-wire";
import { type Fastify } from "../types";
import { log } from "@/utils/log";
import { createAccountRateLimiter } from "@/app/push/webhookNotify";
import {
    createTimedCache,
    fetchSlimVoices,
    proxyTts,
    upstreamErrorReplyStatus,
    validateTtsText,
    type FetchLike,
    type SlimVoice,
} from "@/app/voice/ttsProxy";
import { mintVoiceToken } from "@/app/voice/voiceToken";

const VOICE_FREE_LIMIT_SECONDS = 1200;  // 20 minutes free tier per 30 days (~$0.76 cost)
const VOICE_HARD_LIMIT_SECONDS = 18000; // 5 hours absolute cap per 30 days (even with subscription)
const VOICE_MAX_CONVERSATIONS = 100;    // Max conversations trackable per 30 days (ElevenLabs page_size limit)
const VOICE_EXTRA_LIMIT_SECONDS = 5 * 60 * 60;
const VOICE_EXTRA_LIMIT_PUBLIC_IDS = new Set([
    "cmp66x5u018d9wz0unf56tp07",
]);
const ELEVEN_LABS_API = "https://api.elevenlabs.io/v1/convai";

function getVoiceHardLimitSeconds(userId: string): number {
    if (VOICE_EXTRA_LIMIT_PUBLIC_IDS.has(userId)) {
        return VOICE_HARD_LIMIT_SECONDS + VOICE_EXTRA_LIMIT_SECONDS;
    }
    return VOICE_HARD_LIMIT_SECONDS;
}

function deriveElevenUserId(happyUserId: string): string {
    const hmac = crypto.createHmac("sha256", process.env.HANDY_MASTER_SECRET!);
    hmac.update(happyUserId);
    const digest = hmac.digest();
    const base64url = digest
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    return `u_${base64url}`;
}

/**
 * Get a user's voice usage in seconds over the last 30 days.
 * Queries ElevenLabs directly by user_id (set via participant_name on token mint).
 * ElevenLabs is the source of truth — no local DB needed.
 *
 * Returns { usedSeconds, conversationCount }.
 */
async function getVoiceUsage(
    elevenLabsApiKey: string,
    elevenUserId: string,
): Promise<{ usedSeconds: number; conversationCount: number }> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000).toISOString();

    // Query across all agents — usage is per-user, not per-agent
    const res = await fetch(
        `${ELEVEN_LABS_API}/conversations?user_id=${elevenUserId}&created_after=${thirtyDaysAgo}&page_size=100`,
        { headers: { "xi-api-key": elevenLabsApiKey } }
    );

    if (!res.ok) {
        log({ module: 'voice' }, `ElevenLabs conversations query failed: ${res.status}`);
        return { usedSeconds: 0, conversationCount: 0 };
    }

    const data = (await res.json()) as {
        conversations?: Array<{ call_duration_secs: number }>;
    };

    const conversations = data.conversations || [];
    let usedSeconds = 0;
    for (const c of conversations) {
        usedSeconds += c.call_duration_secs ?? 0;
    }
    return { usedSeconds, conversationCount: conversations.length };
}

async function hasActiveSubscription(userId: string): Promise<boolean> {
    const revenueCatApiKey = process.env.REVENUECAT_API_KEY;
    if (!revenueCatApiKey) return false;

    try {
        const response = await fetch(
            `https://api.revenuecat.com/v2/projects/proj493735ad/customers/${userId}/active_entitlements`,
            {
                method: "GET",
                headers: {
                    "Authorization": `Bearer ${revenueCatApiKey}`,
                },
            }
        );
        if (!response.ok) {
            log({ module: 'voice' }, `RevenueCat check failed for ${userId}: ${response.status}`);
            return false;
        }
        const data = (await response.json()) as { items?: Array<{ entitlement_id: string }> };
        return (data.items?.length ?? 0) > 0;
    } catch {
        return false;
    }
}

export function voiceRoutes(app: Fastify) {
    app.post('/v1/voice/conversations', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                agentId: z.string(),
            }),
            response: {
                200: VoiceConversationResponseSchema,
                500: z.object({ error: z.string() }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { agentId } = request.body;

        log({ module: 'voice' }, `Voice token request from user ${userId}`);

        const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
        if (!elevenLabsApiKey) {
            return reply.code(500).send({ error: 'ELEVENLABS_API_KEY not configured' });
        }
        if (!process.env.REVENUECAT_API_KEY) {
            return reply.code(500).send({ error: 'REVENUECAT_API_KEY not configured' });
        }

        const elevenUserId = deriveElevenUserId(userId);
        const hardLimitSeconds = getVoiceHardLimitSeconds(userId);

        // Check usage from ElevenLabs directly
        const { usedSeconds, conversationCount } = await getVoiceUsage(elevenLabsApiKey, elevenUserId);
        log({ module: 'voice' }, `User ${userId}: ${usedSeconds}s used, ${conversationCount} convos (free=${VOICE_FREE_LIMIT_SECONDS}s, hard=${hardLimitSeconds}s)`);

        // Conversation count cap — we can only track 100 per query (ElevenLabs page_size limit)
        if (conversationCount >= VOICE_MAX_CONVERSATIONS) {
            return reply.send({
                allowed: false as const,
                reason: 'voice_conversation_limit_reached' as const,
                usedSeconds,
                limitSeconds: hardLimitSeconds,
                agentId,
            });
        }

        // Hard cap — normally 5 hours, with account-specific credits applied.
        if (usedSeconds >= hardLimitSeconds) {
            return reply.send({
                allowed: false as const,
                reason: 'voice_hard_limit_reached' as const,
                usedSeconds,
                limitSeconds: hardLimitSeconds,
                agentId,
            });
        }

        // Free tier — 1 hour, then need subscription
        if (usedSeconds >= VOICE_FREE_LIMIT_SECONDS) {
            const subscribed = await hasActiveSubscription(userId);
            log({ module: 'voice' }, `User ${userId}: subscription check = ${subscribed}`);
            if (!subscribed) {
                return reply.send({
                    allowed: false as const,
                    reason: 'subscription_required' as const,
                    usedSeconds,
                    limitSeconds: VOICE_FREE_LIMIT_SECONDS,
                    agentId,
                });
            }
        }

        // Get conversation token (JWT for WebRTC) with user identity
        try {
            const tokenRes = await fetch(
                `${ELEVEN_LABS_API}/conversation/token?agent_id=${agentId}&participant_name=${elevenUserId}`,
                { headers: { 'xi-api-key': elevenLabsApiKey } }
            );

            if (!tokenRes.ok) {
                log({ module: 'voice' }, `Failed to get conversation token for user ${userId}: ${tokenRes.status}`);
                return reply.code(500).send({ error: 'Failed to get voice credentials' });
            }

            const { token: conversationToken } = (await tokenRes.json()) as { token: string };

            // Extract conversation_id from JWT payload (LiveKit room name contains it)
            const jwtPayload = JSON.parse(Buffer.from(conversationToken.split('.')[1], 'base64').toString());
            const conversationId = (jwtPayload.video?.room || '').match(/(conv_[a-zA-Z0-9]+)/)?.[0];

            if (!conversationId) {
                log({ module: 'voice' }, `No conversation_id in JWT for user ${userId}`);
                return reply.code(500).send({ error: 'Failed to get conversation ID' });
            }

            log({ module: 'voice' }, `Voice token issued for user ${userId}, conv=${conversationId}`);
            return reply.send({
                allowed: true as const,
                conversationToken,
                conversationId,
                agentId,
                elevenUserId,
                usedSeconds,
                limitSeconds: usedSeconds >= VOICE_FREE_LIMIT_SECONDS ? hardLimitSeconds : VOICE_FREE_LIMIT_SECONDS,
            });
        } catch (error) {
            log({ module: 'voice' }, `ElevenLabs request error for user ${userId}: ${error}`);
            return reply.code(500).send({ error: 'Failed to get voice credentials' });
        }
    });

    /**
     * Returns voice usage for the authenticated user over the last 30 days.
     * Queries ElevenLabs directly — no local DB needed.
     */
    app.get('/v1/voice/usage', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: VoiceUsageResponseSchema,
                500: z.object({ error: z.string() }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;

        const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
        if (!elevenLabsApiKey) {
            return reply.code(500).send({ error: 'ELEVENLABS_API_KEY not configured' });
        }

        const elevenUserId = deriveElevenUserId(userId);
        const hardLimitSeconds = getVoiceHardLimitSeconds(userId);

        try {
            const [{ usedSeconds, conversationCount }, subscribed] = await Promise.all([
                getVoiceUsage(elevenLabsApiKey, elevenUserId),
                hasActiveSubscription(userId),
            ]);
            return reply.send({
                usedSeconds,
                limitSeconds: subscribed ? hardLimitSeconds : VOICE_FREE_LIMIT_SECONDS,
                conversationCount,
                conversationLimit: VOICE_MAX_CONVERSATIONS,
                elevenUserId,
            });
        } catch (error) {
            log({ module: 'voice' }, `Failed to get voice usage for user ${userId}: ${error}`);
            return reply.code(500).send({ error: 'Failed to get voice usage' });
        }
    });

    /**
     * Speech-to-text proxy. The web client records a short audio clip, base64s
     * it, and posts it here; we forward to ElevenLabs Scribe with the server's
     * API key (which therefore never ships to the browser) and return the plain
     * transcript. Unlike the conversational agent this is dictation only — the
     * client drops the text into the composer for the user to edit, so there's
     * no usage/paywall gating (Scribe is cheap, ~$0.006/min).
     */
    app.post('/v1/voice/transcribe', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                audioBase64: z.string().min(1),
                mimeType: z.string().optional(),
                // Optional ISO-639 hint; omitted → Scribe auto-detects (handles
                // mixed zh/en well).
                languageCode: z.string().optional(),
            }),
            response: {
                200: z.object({ text: z.string() }),
                500: z.object({ error: z.string() }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
        if (!elevenLabsApiKey) {
            return reply.code(500).send({ error: 'ELEVENLABS_API_KEY not configured' });
        }

        const { audioBase64, mimeType, languageCode } = request.body;
        const buffer = Buffer.from(audioBase64, 'base64');
        if (buffer.length === 0) {
            return reply.code(500).send({ error: 'Empty audio' });
        }

        try {
            const type = mimeType || 'audio/webm';
            const ext = type.includes('mp4') || type.includes('mpeg') ? 'mp4' : type.includes('wav') ? 'wav' : 'webm';
            const form = new FormData();
            // scribe_v1 is deprecated upstream; v2 keeps the same interface
            // (batch STT, eats webm/opus directly).
            form.append('model_id', 'scribe_v2');
            form.append('file', new Blob([buffer], { type }), `audio.${ext}`);
            if (languageCode) form.append('language_code', languageCode);

            const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
                method: 'POST',
                headers: { 'xi-api-key': elevenLabsApiKey },
                // Cast: the monorepo's ambient types resolve global fetch/FormData
                // to React Native's; at runtime this is Node (undici) where a
                // global FormData body is correct.
                body: form as any,
            });
            if (!res.ok) {
                const detail = await res.text().catch(() => '');
                log({ module: 'voice' }, `STT failed for user ${userId}: ${res.status} ${detail.slice(0, 200)}`);
                return reply.code(500).send({ error: 'Transcription failed' });
            }
            const data = (await res.json()) as { text?: string };
            return reply.send({ text: (data.text ?? '').trim() });
        } catch (error) {
            log({ module: 'voice' }, `STT error for user ${userId}: ${error}`);
            return reply.code(500).send({ error: 'Transcription failed' });
        }
    });

    // Per-account TTS rate limit — same in-memory limiter school as
    // POST /v1/webhook/notify (see webhookNotify.ts).
    const allowTts = createAccountRateLimiter({ max: 60, windowMs: 60_000 });
    // Voices list barely changes; 60s module-level cache is plenty for a
    // single-instance deployment.
    const voicesCache = createTimedCache<SlimVoice[]>(60_000);

    /**
     * Text-to-speech streaming proxy. The client posts short text; we forward
     * to ElevenLabs' streaming TTS endpoint with the server's API key and pipe
     * the audio/mpeg bytes straight through. If the client disconnects
     * mid-stream we abort the upstream fetch so we stop paying for audio
     * nobody is listening to.
     */
    app.post('/v1/voice/tts', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                text: z.string(),
                voiceId: z.string().optional(),
                modelId: z.string().optional(),
            }),
            // No response schema: 200 is a raw audio/mpeg stream, which
            // doesn't fit the zod type provider's fixed status-code union.
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { text, voiceId, modelId } = request.body;

        const validation = validateTtsText(text);
        if (!validation.ok) {
            return reply.code(400).send({ error: validation.error });
        }

        const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
        if (!elevenLabsApiKey) {
            return reply.code(501).send({ error: 'voice not configured' });
        }

        if (!allowTts.allow(userId)) {
            return reply.code(429).send({ error: 'Too many TTS requests, slow down' });
        }

        // Client gone → abort the upstream fetch. IMPORTANT: listen on the
        // RESPONSE socket, not request.raw — since Node 16 the request stream
        // emits 'close' as soon as its body is fully consumed, which Fastify
        // does BEFORE the handler runs. Depending on hook timing a
        // request-side listener either fires instantly (aborting every
        // request) or is attached after the event already passed (never
        // aborting at all). reply.raw 'close' fires once the response side is
        // done; writableEnded distinguishes a normal completion (nothing to
        // abort) from a mid-stream client disconnect.
        const abort = new AbortController();
        reply.raw.on('close', () => {
            if (!reply.raw.writableEnded) {
                abort.abort();
            }
        });

        try {
            const result = await proxyTts({
                apiKey: elevenLabsApiKey,
                text,
                voiceId,
                modelId,
                signal: abort.signal,
                fetchImpl: fetch as unknown as FetchLike,
            });
            if (result.kind === 'upstream_error') {
                log({ module: 'voice' }, `TTS upstream failed for user ${userId}: ${result.status} ${result.detail.slice(0, 200)}`);
                // Never pass the upstream status through — the client
                // feature-detects this route by status (404 → "server not
                // upgraded" → permanent degrade). 429 stays 429, rest is 502.
                return reply.code(upstreamErrorReplyStatus(result.status)).send({ error: 'TTS failed' });
            }
            if (!result.body) {
                log({ module: 'voice' }, `TTS upstream returned no body for user ${userId}`);
                return reply.code(502).send({ error: 'TTS failed' });
            }
            reply.header('Content-Type', 'audio/mpeg');
            return reply.send(Readable.fromWeb(result.body as any));
        } catch (error) {
            if (abort.signal.aborted) {
                // Client disconnected; nothing left to answer.
                return;
            }
            log({ module: 'voice' }, `TTS error for user ${userId}: ${error}`);
            return reply.code(502).send({ error: 'TTS failed' });
        }
    });

    // Per-account mint rate limit — 30/min (B-069). Same in-memory limiter
    // school as the TTS route above; tokens are one-shot 15-min upstream, so
    // this only guards against a runaway client hammering the mint endpoint.
    const allowVoiceToken = createAccountRateLimiter({ max: 30, windowMs: 60_000 });

    /**
     * Single-use token mint for browser-direct ElevenLabs WebSockets (B-069
     * streaming voice). `tts` → stream-input TTS socket, `stt` → realtime
     * Scribe socket. The browser authenticates the socket with this token
     * (query param) — the API key itself never ships to the client. Tokens
     * are one-shot and expire after 15 minutes upstream.
     *
     * Status discipline mirrors /v1/voice/tts: the client feature-detects by
     * status (404 = old server, 501 = voice not configured → fall back to the
     * HTTP pipeline), so upstream errors are never passed through verbatim
     * (429 stays 429, everything else → 502).
     */
    app.post('/v1/voice/token', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                type: z.enum(['tts', 'stt']),
            }),
            response: {
                200: z.object({ token: z.string() }),
                429: z.object({ error: z.string() }),
                501: z.object({ error: z.string() }),
                502: z.object({ error: z.string() }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { type } = request.body;

        const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
        if (!elevenLabsApiKey) {
            return reply.code(501).send({ error: 'voice not configured' });
        }

        if (!allowVoiceToken.allow(userId)) {
            return reply.code(429).send({ error: 'Too many token requests, slow down' });
        }

        try {
            const result = await mintVoiceToken({
                apiKey: elevenLabsApiKey,
                type,
                fetchImpl: fetch as unknown as FetchLike,
            });
            if (result.kind === 'upstream_error') {
                log({ module: 'voice' }, `Voice token mint failed for user ${userId} (${type}): ${result.status} ${result.detail.slice(0, 200)}`);
                return reply.code(upstreamErrorReplyStatus(result.status)).send({ error: 'Token mint failed' });
            }
            if (result.kind === 'bad_payload') {
                log({ module: 'voice' }, `Voice token mint returned unexpected payload for user ${userId} (${type})`);
                return reply.code(502).send({ error: 'Token mint failed' });
            }
            return reply.send({ token: result.token });
        } catch (error) {
            log({ module: 'voice' }, `Voice token mint error for user ${userId} (${type}): ${error}`);
            return reply.code(502).send({ error: 'Token mint failed' });
        }
    });

    /**
     * Slim voices list for the TTS voice picker. Proxies ElevenLabs
     * GET /v1/voices, strips it down to what the client needs, and caches the
     * result for 60s.
     */
    app.get('/v1/voice/tts/voices', {
        preHandler: app.authenticate,
        // No response schema kept for simplicity; the 200 shape is
        // {voices: SlimVoice[]} (see slimVoices()).
    }, async (request, reply) => {
        const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
        if (!elevenLabsApiKey) {
            return reply.code(501).send({ error: 'voice not configured' });
        }

        const cached = voicesCache.get();
        if (cached) {
            return reply.send({ voices: cached });
        }

        try {
            const result = await fetchSlimVoices({
                apiKey: elevenLabsApiKey,
                fetchImpl: fetch as unknown as FetchLike,
            });
            if (!result.ok) {
                log({ module: 'voice' }, `Voices list failed: ${result.status}`);
                // Same status discipline as /v1/voice/tts: upstream codes are
                // never passed through (429 stays, everything else → 502).
                return reply.code(upstreamErrorReplyStatus(result.status)).send({ error: 'Failed to list voices' });
            }
            voicesCache.set(result.voices);
            return reply.send({ voices: result.voices });
        } catch (error) {
            log({ module: 'voice' }, `Voices list error: ${error}`);
            return reply.code(502).send({ error: 'Failed to list voices' });
        }
    });
}
