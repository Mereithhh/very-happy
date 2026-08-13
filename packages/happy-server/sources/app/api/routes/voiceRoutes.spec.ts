/**
 * Route-level tests for the TTS proxy endpoints (B-051 review fixes).
 *
 * S1 regression: the client-disconnect abort must hang off the RESPONSE
 * socket. The old code did `request.raw.on('close', () => abort.abort())` —
 * since Node 16 the request stream emits 'close' as soon as its body is
 * fully consumed, which Fastify does BEFORE the handler runs. Depending on
 * hook timing that listener either fires instantly (every request aborts its
 * own upstream fetch) or is attached after the event already passed (client
 * disconnects never abort anything — dead code). Both modes are covered
 * below; the timing only reproduces over a real socket, so these tests
 * listen on 127.0.0.1 and use a real HTTP client instead of inject().
 *
 * S2: upstream error statuses are never passed through — the web client
 * feature-detects these endpoints by status (404 → "server not upgraded" →
 * permanent degrade), so upstream 429 stays 429 and everything else maps
 * to 502.
 */
import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

vi.mock("@/utils/log", () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }));

import { voiceRoutes } from "./voiceRoutes";

// Real fetch for talking to the listening server — the GLOBAL fetch is
// stubbed per test to play the ElevenLabs upstream. Typed loosely because
// the monorepo's ambient types resolve fetch/AbortSignal to React Native's;
// at runtime this is Node (undici).
type RealResponse = {
    status: number;
    headers: { get(name: string): string | null };
    json(): Promise<unknown>;
    arrayBuffer(): Promise<ArrayBuffer>;
    body: { getReader(): { read(): Promise<unknown>; cancel(): Promise<void> } } | null;
};
const realFetch: (url: string, init?: Record<string, unknown>) => Promise<RealResponse> =
    (globalThis as any).fetch.bind(globalThis);
const NodeAbortSignal = AbortSignal as unknown as { timeout(ms: number): unknown };

/** Structural view of Node's AbortSignal as seen by the upstream mocks. */
type MinimalAbortSignal = {
    aborted: boolean;
    addEventListener?: (type: string, listener: () => void, options?: { once?: boolean }) => void;
};

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startApp(): Promise<{ app: Fastify; base: string }> {
    // forceCloseConnections: on Linux, undici keeps the test client's
    // keep-alive/streaming sockets pooled (reader.cancel() returns the
    // connection instead of destroying it), so a plain close() waits on them
    // FOREVER — deterministic 30s hook burn on any Linux runner while macOS
    // passes. This is fastify's official switch for exactly that.
    const app = fastify({ forceCloseConnections: true });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate("authenticate", async (request: any) => {
        request.userId = "user-1";
    });
    voiceRoutes(typed);
    await typed.listen({ port: 0, host: "127.0.0.1" });
    const address = typed.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    return { app: typed, base: `http://127.0.0.1:${port}` };
}

/** Upstream stub: resolves after `delayMs` (honoring the abort signal like
 *  undici would), then streams `chunks` with small gaps. */
function slowStreamUpstream(chunks: Uint8Array[], delayMs: number) {
    const seenAborts: boolean[] = [];
    const impl = vi.fn(async (_url: string, init?: { signal?: MinimalAbortSignal }) => {
        const signal = init?.signal;
        await new Promise<void>((resolve, reject) => {
            const abortError = () => {
                const err = new Error("This operation was aborted");
                err.name = "AbortError";
                return err;
            };
            if (signal?.aborted) {
                reject(abortError());
                return;
            }
            const timer = setTimeout(resolve, delayMs);
            signal?.addEventListener?.("abort", () => {
                clearTimeout(timer);
                reject(abortError());
            }, { once: true });
        });
        seenAborts.push(signal?.aborted ?? false);
        const body = new ReadableStream<Uint8Array>({
            async start(controller) {
                for (const chunk of chunks) {
                    controller.enqueue(chunk);
                    await sleep(10);
                }
                controller.close();
            },
        });
        return { ok: true, status: 200, body, text: async () => "", json: async () => ({}) };
    });
    return { impl, seenAborts };
}

function errorUpstream(status: number) {
    return vi.fn(async () => ({
        ok: false,
        status,
        body: null,
        text: async () => "upstream says no",
        json: async () => ({}),
    }));
}

describe("voiceRoutes — /v1/voice/tts + /v1/voice/tts/voices", () => {
    let app: Fastify | null = null;
    const originalApiKey = process.env.ELEVENLABS_API_KEY;

    beforeEach(() => {
        process.env.ELEVENLABS_API_KEY = "test-api-key";
    });

    afterEach(async () => {
        vi.unstubAllGlobals();
        if (app) {
            await app.close();
            app = null;
        }
        if (originalApiKey === undefined) delete process.env.ELEVENLABS_API_KEY;
        else process.env.ELEVENLABS_API_KEY = originalApiKey;
        // 30s hook budget: closing a server with a just-severed streaming
        // connection is slow on loaded CI runners (4-core shared box).
    }, 30_000);

    it("S1 regression: streams a complete 200 over a real socket while the upstream is slow (request.raw 'close' used to abort every request)", async () => {
        const chunks = [
            new Uint8Array(Buffer.from("aaa")),
            new Uint8Array(Buffer.from("bbb")),
            new Uint8Array(Buffer.from("ccc")),
        ];
        // 100ms upstream latency: plenty of time for the request stream's
        // post-body-consumption 'close' (the old bug trigger) to fire first.
        const upstream = slowStreamUpstream(chunks, 100);
        vi.stubGlobal("fetch", upstream.impl);

        const started = await startApp();
        app = started.app;
        const res = await realFetch(`${started.base}/v1/voice/tts`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: "hello world" }),
            // Old code never replied (bare return after self-abort) — turn
            // that hang into a test failure instead of a suite timeout.
            signal: NodeAbortSignal.timeout(5000),
        });

        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("audio/mpeg");
        const bytes = Buffer.from(await res.arrayBuffer());
        expect(bytes.toString("utf8")).toBe("aaabbbccc");
        expect(upstream.impl).toHaveBeenCalledTimes(1);
        // The upstream fetch survived to completion un-aborted.
        expect(upstream.seenAborts).toEqual([false]);
    });

    it("S1 regression: aborts the upstream fetch when the client disconnects mid-stream (request.raw listener never fired at all)", async () => {
        // Endless upstream stream — only an abort of the upstream fetch's
        // signal (via the route's reply.raw 'close' listener) ends it.
        let upstreamSignal: MinimalAbortSignal | undefined;
        vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { signal?: MinimalAbortSignal }) => {
            upstreamSignal = init?.signal;
            const body = new ReadableStream<Uint8Array>({
                async pull(controller) {
                    await sleep(20);
                    controller.enqueue(new Uint8Array([65, 66, 67]));
                },
            });
            return { ok: true, status: 200, body, text: async () => "", json: async () => ({}) };
        }));

        const started = await startApp();
        app = started.app;
        const clientAbort = new AbortController();
        const res = await realFetch(`${started.base}/v1/voice/tts`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: "hello world" }),
            signal: clientAbort.signal,
        });
        expect(res.status).toBe(200);
        // Read one chunk to prove streaming started, then walk away.
        const reader = res.body!.getReader();
        await reader.read();
        clientAbort.abort();

        // The route must notice the disconnect and abort the upstream fetch.
        // Generous deadline on purpose: loaded CI runners (4-core, shared)
        // stretch socket-close propagation well past dev-machine timings.
        const deadline = Date.now() + 15_000;
        while (!upstreamSignal?.aborted && Date.now() < deadline) {
            await sleep(20);
        }
        expect(upstreamSignal?.aborted).toBe(true);
        // Release the half-open connection NOW so afterEach's app.close()
        // doesn't sit waiting on it (the hook-timeout flake on slow runners).
        await reader.cancel().catch(() => undefined);
    }, 30_000);

    it("S2: maps an upstream TTS 404 to 502 instead of passing it through", async () => {
        vi.stubGlobal("fetch", errorUpstream(404));
        const started = await startApp();
        app = started.app;
        const res = await realFetch(`${started.base}/v1/voice/tts`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: "hello" }),
        });
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: "TTS failed" });
    });

    it("S2: preserves an upstream TTS 429 as 429", async () => {
        vi.stubGlobal("fetch", errorUpstream(429));
        const started = await startApp();
        app = started.app;
        const res = await realFetch(`${started.base}/v1/voice/tts`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: "hello" }),
        });
        expect(res.status).toBe(429);
        expect(await res.json()).toEqual({ error: "TTS failed" });
    });

    it("S2: maps an upstream voices-list 404 to 502", async () => {
        vi.stubGlobal("fetch", errorUpstream(404));
        const started = await startApp();
        app = started.app;
        const res = await realFetch(`${started.base}/v1/voice/tts/voices`);
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: "Failed to list voices" });
    });

    it("S2: preserves an upstream voices-list 429 as 429", async () => {
        vi.stubGlobal("fetch", errorUpstream(429));
        const started = await startApp();
        app = started.app;
        const res = await realFetch(`${started.base}/v1/voice/tts/voices`);
        expect(res.status).toBe(429);
        expect(await res.json()).toEqual({ error: "Failed to list voices" });
    });
});

describe("voiceRoutes — /v1/voice/token (B-069)", () => {
    let app: Fastify | null = null;
    const originalApiKey = process.env.ELEVENLABS_API_KEY;

    beforeEach(() => {
        process.env.ELEVENLABS_API_KEY = "test-api-key";
    });

    afterEach(async () => {
        vi.unstubAllGlobals();
        if (app) {
            await app.close();
            app = null;
        }
        if (originalApiKey === undefined) delete process.env.ELEVENLABS_API_KEY;
        else process.env.ELEVENLABS_API_KEY = originalApiKey;
    }, 30_000);

    function tokenUpstream(token = "sutkn_route_test") {
        return vi.fn(async () => ({
            ok: true,
            status: 200,
            body: null,
            text: async () => "",
            json: async () => ({ token }),
        }));
    }

    async function postToken(base: string, type: string) {
        return realFetch(`${base}/v1/voice/token`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type }),
        });
    }

    it("mints a tts token via the tts_websocket upstream type", async () => {
        const upstream = tokenUpstream();
        vi.stubGlobal("fetch", upstream);
        const started = await startApp();
        app = started.app;
        const res = await postToken(started.base, "tts");
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ token: "sutkn_route_test" });
        expect(upstream).toHaveBeenCalledTimes(1);
        expect((upstream.mock.calls[0] as unknown[])[0]).toBe(
            "https://api.elevenlabs.io/v1/single-use-token/tts_websocket",
        );
    });

    it("mints an stt token via the realtime_scribe upstream type", async () => {
        const upstream = tokenUpstream();
        vi.stubGlobal("fetch", upstream);
        const started = await startApp();
        app = started.app;
        const res = await postToken(started.base, "stt");
        expect(res.status).toBe(200);
        expect((upstream.mock.calls[0] as unknown[])[0]).toBe(
            "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe",
        );
    });

    it("rejects unknown token types with 400", async () => {
        vi.stubGlobal("fetch", tokenUpstream());
        const started = await startApp();
        app = started.app;
        const res = await postToken(started.base, "webrtc");
        expect(res.status).toBe(400);
    });

    it("answers 501 when ELEVENLABS_API_KEY is not configured", async () => {
        delete process.env.ELEVENLABS_API_KEY;
        const upstream = tokenUpstream();
        vi.stubGlobal("fetch", upstream);
        const started = await startApp();
        app = started.app;
        const res = await postToken(started.base, "tts");
        expect(res.status).toBe(501);
        expect(await res.json()).toEqual({ error: "voice not configured" });
        expect(upstream).not.toHaveBeenCalled();
    });

    it("maps an upstream mint failure to 502 (never passes the status through)", async () => {
        vi.stubGlobal("fetch", errorUpstream(404));
        const started = await startApp();
        app = started.app;
        const res = await postToken(started.base, "tts");
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: "Token mint failed" });
    });

    it("preserves an upstream mint 429 as 429", async () => {
        vi.stubGlobal("fetch", errorUpstream(429));
        const started = await startApp();
        app = started.app;
        const res = await postToken(started.base, "tts");
        expect(res.status).toBe(429);
    });

    it("answers 502 when the upstream 200 payload has no token", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({
            ok: true,
            status: 200,
            body: null,
            text: async () => "",
            json: async () => ({ unexpected: true }),
        })));
        const started = await startApp();
        app = started.app;
        const res = await postToken(started.base, "tts");
        expect(res.status).toBe(502);
    });

    it("rate limits per account at 30/min", async () => {
        vi.stubGlobal("fetch", tokenUpstream());
        const started = await startApp();
        app = started.app;
        for (let i = 0; i < 30; i++) {
            const res = await postToken(started.base, "tts");
            expect(res.status).toBe(200);
        }
        const res = await postToken(started.base, "stt");
        expect(res.status).toBe(429);
        expect(await res.json()).toEqual({ error: "Too many token requests, slow down" });
    });
});
