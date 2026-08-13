/**
 * asrStream — streaming ASR over ElevenLabs' realtime Scribe WebSocket (B-069).
 *
 * While the PTT button is held, an AudioWorklet taps the mic stream, the tap
 * is downsampled to PCM16@16kHz (pure functions below) and shipped as
 * `input_audio_chunk` JSON messages. The server answers `partial_transcript`
 * events (live caption); on release we send the last chunk with
 * `commit: true` (manual commit strategy — there is no standalone commit
 * message) and wait for the `committed_transcript` to hand back as the final
 * text. Auth = single-use token in the `token` query param.
 *
 * Layering for testability:
 *  - pure: downsampler, float→PCM16, base64 packing, frame chunking;
 *  - `createAsrSocket` — the WS protocol state machine, socket injected;
 *  - `startAsrStream` — browser-only glue (AudioContext + worklet via Blob
 *    URL, no build assets), returns null whenever ANYTHING is unavailable so
 *    the caller falls back to the MediaRecorder batch path.
 */

import type { WsFactory, WsLike } from './ttsStream';

export const ASR_TARGET_SAMPLE_RATE = 16000;
/** Realtime STT model (docs: scribe_v2_realtime is the realtime variant; the
 *  default when omitted is undocumented, so we always pass it explicitly). */
export const ASR_MODEL_ID = 'scribe_v2_realtime';
/** ~250ms of 16kHz audio per input_audio_chunk. */
export const ASR_FRAME_SAMPLES = 4000;
/** how long commit() waits for the committed transcript before giving up */
export const ASR_COMMIT_TIMEOUT_MS = 8000;

// ── PCM pipeline (pure) ─────────────────────────────────────────────────────

/**
 * Streaming downsampler with carry — window-averages `ratio` input samples
 * per output sample and keeps the fractional remainder for the next push, so
 * non-integer ratios (44100→16000) don't accumulate drift.
 */
export function createDownsampler(fromRate: number, toRate: number): {
    push(chunk: Float32Array): Float32Array;
} {
    if (fromRate <= toRate) {
        // equal (or upstream lower — never in practice): pass through
        return { push: (chunk) => chunk.slice() };
    }
    const ratio = fromRate / toRate;
    let carry = new Float32Array(0);
    return {
        push(chunk: Float32Array): Float32Array {
            const input = new Float32Array(carry.length + chunk.length);
            input.set(carry, 0);
            input.set(chunk, carry.length);
            const outCount = Math.floor(input.length / ratio);
            const out = new Float32Array(outCount);
            let consumed = 0;
            for (let i = 0; i < outCount; i++) {
                const start = Math.round(i * ratio);
                const end = Math.min(input.length, Math.max(start + 1, Math.round((i + 1) * ratio)));
                let sum = 0;
                for (let j = start; j < end; j++) sum += input[j];
                out[i] = sum / (end - start);
                consumed = end;
            }
            carry = input.slice(consumed);
            return out;
        },
    };
}

/** Clamp to [-1, 1] and scale to 16-bit signed integers. */
export function floatToPcm16(input: Float32Array): Int16Array {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
        const v = Math.max(-1, Math.min(1, input[i]));
        out[i] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
    }
    return out;
}

/** Little-endian PCM16 → base64 (matches ElevenLabs' pcm_16000 format). */
export function pcm16ToBase64(samples: Int16Array): string {
    const bytes = new Uint8Array(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
        bytes[i * 2] = samples[i] & 0xff;
        bytes[i * 2 + 1] = (samples[i] >> 8) & 0xff;
    }
    let bin = '';
    const STEP = 0x8000; // keep fromCharCode argument counts sane
    for (let i = 0; i < bytes.length; i += STEP) {
        bin += String.fromCharCode(...bytes.subarray(i, i + STEP));
    }
    return btoa(bin);
}

/**
 * Full mic→wire packer: downsample to the target rate, convert to PCM16, and
 * cut into fixed-size frames. push() returns zero or more complete frames;
 * flush() returns whatever tail remains (possibly empty).
 */
export function createPcmPacker(opts: {
    sourceRate: number;
    targetRate?: number;
    frameSamples?: number;
}): {
    push(chunk: Float32Array): Int16Array[];
    flush(): Int16Array;
} {
    const targetRate = opts.targetRate ?? ASR_TARGET_SAMPLE_RATE;
    const frameSamples = opts.frameSamples ?? ASR_FRAME_SAMPLES;
    const down = createDownsampler(opts.sourceRate, targetRate);
    let acc = new Int16Array(0);
    return {
        push(chunk: Float32Array): Int16Array[] {
            const pcm = floatToPcm16(down.push(chunk));
            const merged = new Int16Array(acc.length + pcm.length);
            merged.set(acc, 0);
            merged.set(pcm, acc.length);
            const frames: Int16Array[] = [];
            let off = 0;
            while (merged.length - off >= frameSamples) {
                frames.push(merged.slice(off, off + frameSamples));
                off += frameSamples;
            }
            acc = merged.slice(off);
            return frames;
        },
        flush(): Int16Array {
            const tail = acc;
            acc = new Int16Array(0);
            return tail;
        },
    };
}

// ── WS protocol state machine ───────────────────────────────────────────────

export function buildAsrStreamUrl(token: string, languageCode?: string | null): string {
    const params = new URLSearchParams({
        model_id: ASR_MODEL_ID,
        token,
        audio_format: `pcm_${ASR_TARGET_SAMPLE_RATE}`,
        commit_strategy: 'manual',
    });
    // official query param `language_code`; omitted → Scribe auto-detects
    if (languageCode) params.set('language_code', languageCode);
    return `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params.toString()}`;
}

export interface AsrSocket {
    /** resolves true once the socket is open (false = connect failed) */
    ready: Promise<boolean>;
    sendAudio(frame: Int16Array): void;
    /**
     * Send the tail frame with commit:true and wait for the committed
     * transcript. Resolves null on failure/timeout. Idempotent-ish: second
     * call returns the same promise.
     */
    commit(tail: Int16Array): Promise<string | null>;
    cancel(): void;
}

interface AsrServerMessage {
    message_type?: unknown;
    text?: unknown;
    error?: unknown;
}

/** 20ms of silence — commit must ride on an input_audio_chunk, and
 *  audio_base_64 is a required field, so an empty tail needs a stand-in. */
function silenceFrame(): Int16Array {
    return new Int16Array(ASR_TARGET_SAMPLE_RATE / 50);
}

export function createAsrSocket(opts: {
    token: string;
    onPartial: (text: string) => void;
    /** ISO-639 hint; null/undefined → auto-detect */
    languageCode?: string | null;
    wsFactory?: WsFactory;
    commitTimeoutMs?: number;
}): AsrSocket {
    const commitTimeoutMs = opts.commitTimeoutMs ?? ASR_COMMIT_TIMEOUT_MS;
    const factory: WsFactory =
        opts.wsFactory ?? ((url) => new WebSocket(url) as unknown as WsLike);

    let readyResolve!: (ok: boolean) => void;
    const ready = new Promise<boolean>((r) => {
        readyResolve = r;
    });
    let opened = false;
    let failed = false;
    let commitPromise: Promise<string | null> | null = null;
    let commitResolve: ((text: string | null) => void) | null = null;

    let ws: WsLike;
    try {
        ws = factory(buildAsrStreamUrl(opts.token, opts.languageCode));
    } catch {
        readyResolve(false);
        return {
            ready,
            sendAudio: () => {},
            commit: async () => null,
            cancel: () => {},
        };
    }

    const fail = () => {
        if (failed) return;
        failed = true;
        readyResolve(false);
        if (commitResolve) {
            commitResolve(null);
            commitResolve = null;
        }
        try {
            ws.close();
        } catch {
            // already closed
        }
    };

    const sendChunk = (frame: Int16Array, commit: boolean) => {
        if (failed) return;
        try {
            ws.send(
                JSON.stringify({
                    message_type: 'input_audio_chunk',
                    audio_base_64: pcm16ToBase64(frame),
                    commit,
                    sample_rate: ASR_TARGET_SAMPLE_RATE,
                }),
            );
        } catch {
            fail();
        }
    };

    ws.onopen = () => {
        opened = true;
        if (!failed) readyResolve(true);
    };

    ws.onmessage = (ev) => {
        if (failed || typeof ev.data !== 'string') return;
        let msg: AsrServerMessage;
        try {
            msg = JSON.parse(ev.data);
        } catch {
            return;
        }
        const type = typeof msg.message_type === 'string' ? msg.message_type : '';
        // the error family is wide (auth_error, quota_exceeded, …) but every
        // member carries an `error` string — that's the discriminator
        if (typeof msg.error === 'string') {
            fail();
            return;
        }
        const text = typeof msg.text === 'string' ? msg.text : null;
        if (text === null) return;
        if (type === 'partial_transcript' || type === 'final_transcript' || type === 'final_transcript_with_timestamps') {
            opts.onPartial(text);
            return;
        }
        if (type.startsWith('committed_transcript')) {
            if (commitResolve) {
                commitResolve(text);
                commitResolve = null;
            }
        }
    };

    ws.onerror = () => fail();
    ws.onclose = () => {
        if (!opened) readyResolve(false);
        // mid-session close without commit answered = failure
        if (commitResolve) {
            commitResolve(null);
            commitResolve = null;
        }
        failed = true;
    };

    return {
        ready,
        sendAudio: (frame) => {
            if (frame.length > 0) sendChunk(frame, false);
        },
        commit: (tail) => {
            if (commitPromise) return commitPromise;
            if (failed) return Promise.resolve(null);
            commitPromise = new Promise<string | null>((resolve) => {
                commitResolve = resolve;
                sendChunk(tail.length > 0 ? tail : silenceFrame(), true);
                setTimeout(() => {
                    if (commitResolve) {
                        commitResolve(null);
                        commitResolve = null;
                        try {
                            ws.close();
                        } catch {
                            // ignore
                        }
                    }
                }, commitTimeoutMs);
            }).then((text) => {
                try {
                    ws.close();
                } catch {
                    // ignore
                }
                return text;
            });
            return commitPromise;
        },
        cancel: () => {
            failed = true;
            if (commitResolve) {
                commitResolve(null);
                commitResolve = null;
            }
            try {
                ws.close();
            } catch {
                // ignore
            }
        },
    };
}

// ── browser glue: worklet tap + session ─────────────────────────────────────

/** Feature probe — any miss means the caller should use the batch path. */
export function isAsrStreamSupported(): boolean {
    return (
        typeof WebSocket !== 'undefined' &&
        typeof AudioWorkletNode !== 'undefined' &&
        (typeof AudioContext !== 'undefined' ||
            typeof (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext !== 'undefined')
    );
}

/** Inline worklet (registered via Blob URL — no build asset): copies each
 *  128-sample input block to the main thread. */
const PCM_TAP_WORKLET = `
class VhPcmTap extends AudioWorkletProcessor {
    process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (ch && ch.length > 0) this.port.postMessage(ch.slice(0));
        return true;
    }
}
registerProcessor('vh-pcm-tap', VhPcmTap);
`;

export interface AsrStreamSession {
    /** stop capturing, commit, resolve the final transcript (null = failed) */
    commit(): Promise<string | null>;
    /** slide-out cancel: discard everything */
    cancel(): void;
}

/**
 * Start a streaming ASR session on an existing mic stream.
 *
 * The worklet tap starts buffering IMMEDIATELY (locally, before the token
 * round-trip finishes) so the first syllables are not lost to mint/connect
 * latency; buffered frames are flushed once the socket is ready.
 *
 * Returns null when anything is unavailable or fails to start — the caller
 * falls back to the MediaRecorder batch path for this press.
 */
export async function startAsrStream(opts: {
    stream: MediaStream;
    mintToken: () => Promise<string | null>;
    onPartial: (text: string) => void;
    /** ISO-639 hint; null/undefined → auto-detect */
    languageCode?: string | null;
    wsFactory?: WsFactory;
}): Promise<AsrStreamSession | null> {
    if (!isAsrStreamSupported()) return null;

    const Ctor: typeof AudioContext | undefined =
        (globalThis as { AudioContext?: typeof AudioContext }).AudioContext ??
        (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;

    let ctx: AudioContext;
    try {
        ctx = new Ctor();
    } catch {
        return null;
    }

    let node: AudioWorkletNode | null = null;
    let sourceNode: MediaStreamAudioSourceNode | null = null;
    const workletUrl = URL.createObjectURL(new Blob([PCM_TAP_WORKLET], { type: 'application/javascript' }));
    const teardownAudio = () => {
        try {
            sourceNode?.disconnect();
        } catch {
            // ignore
        }
        try {
            node?.port.close();
        } catch {
            // ignore
        }
        void ctx.close().catch(() => undefined);
        URL.revokeObjectURL(workletUrl);
    };

    try {
        await ctx.audioWorklet.addModule(workletUrl);
        if (ctx.state !== 'running') await ctx.resume().catch(() => undefined);
        sourceNode = ctx.createMediaStreamSource(opts.stream);
        node = new AudioWorkletNode(ctx, 'vh-pcm-tap', { numberOfInputs: 1, numberOfOutputs: 0 });
    } catch {
        teardownAudio();
        return null;
    }

    const packer = createPcmPacker({ sourceRate: ctx.sampleRate });
    let socket: AsrSocket | null = null;
    let dead = false;
    const preBuffer: Int16Array[] = [];

    node.port.onmessage = (e: MessageEvent) => {
        if (dead) return;
        const data = e.data;
        if (!(data instanceof Float32Array)) return;
        for (const frame of packer.push(data)) {
            if (socket) socket.sendAudio(frame);
            else preBuffer.push(frame);
        }
    };
    sourceNode.connect(node);

    // token + socket AFTER the tap is live (buffered frames cover the gap)
    const token = await opts.mintToken();
    if (!token) {
        dead = true;
        teardownAudio();
        return null;
    }

    const s = createAsrSocket({
        token,
        onPartial: opts.onPartial,
        languageCode: opts.languageCode,
        wsFactory: opts.wsFactory,
    });
    const ok = await s.ready;
    if (!ok) {
        dead = true;
        teardownAudio();
        return null;
    }
    for (const frame of preBuffer) s.sendAudio(frame);
    preBuffer.length = 0;
    socket = s;

    return {
        commit: async () => {
            if (dead) return null;
            dead = true;
            const tail = packer.flush();
            teardownAudio();
            return s.commit(tail);
        },
        cancel: () => {
            if (dead) return;
            dead = true;
            s.cancel();
            teardownAudio();
        },
    };
}
