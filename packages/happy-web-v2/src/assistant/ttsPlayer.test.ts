/**
 * TtsPlayer effect-layer regression tests (B-051 review W1/W4).
 *
 * The queue SEMANTICS live in ttsQueue.test.ts; these tests cover the pump's
 * liveness against a mocked AudioContext:
 *  - W1: stop() during playback must resolve the in-flight playback promise,
 *    otherwise the pump deadlocks and every later enqueue is silently dropped.
 *  - W4: a suspended context is resume()d before playback instead of skipping.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TtsPlayer, type TtsPlayerCallbacks } from './ttsPlayer';
import { getAssistantAudioContext } from './iosAudioUnlock';

vi.mock('./iosAudioUnlock', () => ({
    getAssistantAudioContext: vi.fn(),
}));

const mockedGetCtx = vi.mocked(getAssistantAudioContext);

interface FakeSource {
    buffer: unknown;
    onended: (() => void) | null;
    connect: () => void;
    start: () => void;
    stop: () => void;
}

/** Minimal AudioContext stand-in: sources "play" until their onended is fired. */
function makeFakeCtx(initialState: AudioContextState = 'running') {
    const sources: FakeSource[] = [];
    const ctx = {
        state: initialState,
        destination: {},
        resume: vi.fn(async () => {
            ctx.state = 'running';
        }),
        decodeAudioData: vi.fn(async (_data: ArrayBuffer) => ({ duration: 1 })),
        createBufferSource: vi.fn(() => {
            const source: FakeSource = {
                buffer: null,
                onended: null,
                connect: () => {},
                start: () => {}, // playback "hangs" until onended fires (real Web Audio behavior)
                stop: () => {},  // deliberately does NOT fire onended — stop() nulls it first anyway
            };
            sources.push(source);
            return source;
        }),
    };
    return { ctx: ctx as unknown as AudioContext, raw: ctx, sources };
}

function makeCallbacks(): TtsPlayerCallbacks & { speakingLog: boolean[] } {
    const speakingLog: boolean[] = [];
    return {
        speakingLog,
        synthesize: vi.fn(async () => ({ kind: 'ok' as const, data: new ArrayBuffer(4) })),
        onSpeakingChange: (v: boolean) => speakingLog.push(v),
        onUnsupported: vi.fn(),
    };
}

/** Let all pending microtasks (fetch/decode awaits) settle. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
    vi.clearAllMocks();
});

describe('TtsPlayer pump liveness (W1)', () => {
    it('stop() during playback resolves the in-flight promise — a later enqueue still plays', async () => {
        const { ctx, sources } = makeFakeCtx();
        mockedGetCtx.mockReturnValue(ctx);
        const cb = makeCallbacks();
        const player = new TtsPlayer(cb);

        player.enqueue({ id: 'a', text: 'first' });
        await flush();
        expect(sources.length).toBe(1); // 'a' is playing (source created, awaiting onended)

        // barge-in: user presses PTT mid-reply
        player.stop();
        await flush();

        // regression: before the fix the pump was stuck awaiting 'a' forever,
        // so 'b' was never synthesized/played
        player.enqueue({ id: 'b', text: 'second' });
        await flush();
        expect(cb.synthesize).toHaveBeenCalledTimes(2);
        expect(sources.length).toBe(2);

        // and the second utterance completes normally
        sources[1].onended?.();
        await flush();
        expect(cb.speakingLog[cb.speakingLog.length - 1]).toBe(false);
        player.dispose();
    });

    it('stop() during playback then finished source does not double-advance the queue', async () => {
        const { ctx, sources } = makeFakeCtx();
        mockedGetCtx.mockReturnValue(ctx);
        const cb = makeCallbacks();
        const player = new TtsPlayer(cb);

        player.enqueue({ id: 'a', text: 'first' });
        player.enqueue({ id: 'b', text: 'second' });
        await flush();
        expect(sources.length).toBe(1);

        player.stop(); // drops 'b' from the queue and unblocks the pump
        await flush();
        expect(sources.length).toBe(1); // 'b' was dropped, not started

        // dedupe memory survives stop: re-enqueueing played/dropped ids is a no-op
        player.enqueue({ id: 'a', text: 'first' });
        player.enqueue({ id: 'b', text: 'second' });
        await flush();
        expect(sources.length).toBe(1);

        // fresh ids still play
        player.enqueue({ id: 'c', text: 'third' });
        await flush();
        expect(sources.length).toBe(2);
        player.dispose();
    });

    it('dispose() during playback also unblocks the pump (no dangling promise)', async () => {
        const { ctx, sources } = makeFakeCtx();
        mockedGetCtx.mockReturnValue(ctx);
        const cb = makeCallbacks();
        const player = new TtsPlayer(cb);

        player.enqueue({ id: 'a', text: 'first' });
        await flush();
        expect(sources.length).toBe(1);

        player.dispose();
        await flush();
        // disposed players ignore enqueue entirely
        player.enqueue({ id: 'b', text: 'second' });
        await flush();
        expect(cb.synthesize).toHaveBeenCalledTimes(1);
    });
});

describe('TtsPlayer streaming path (B-069)', () => {
    // two sentences after splitIntoSentences (each ≥ minChars)
    const TWO_SENTENCES = 'This is sentence number one. This is sentence number two.';
    const S1 = 'This is sentence number one.';
    const S2 = 'This is sentence number two.';

    function deferred<T>() {
        let resolve!: (v: T) => void;
        const promise = new Promise<T>((r) => {
            resolve = r;
        });
        return { promise, resolve };
    }

    function makeStream(overrides?: Partial<import('./ttsPlayer').TtsStreamCallbacks>) {
        let disabled = false;
        const sentenceDeferreds: Array<ReturnType<typeof deferred<Uint8Array | null>>> = [];
        const outcomeDeferred = deferred<{ kind: 'complete' } | { kind: 'failed'; failedAt: number } | { kind: 'aborted' }>();
        const abort = vi.fn(() => {
            for (const d of sentenceDeferreds) d.resolve(null);
        });
        const openStream = vi.fn((opts: { token: string; sentences: string[]; voiceId?: string }) => {
            for (const _ of opts.sentences) sentenceDeferreds.push(deferred<Uint8Array | null>());
            return {
                sentenceAudio: sentenceDeferreds.map((d) => d.promise),
                outcome: outcomeDeferred.promise,
                abort,
            };
        });
        const stream = {
            mintToken: vi.fn(async () => ({ kind: 'ok' as const, token: 'sutkn' })),
            openStream,
            getVoiceId: () => undefined,
            isDisabled: () => disabled,
            disable: vi.fn(() => {
                disabled = true;
            }),
            ...overrides,
        };
        return { stream, openStream, sentenceDeferreds, outcomeDeferred, abort };
    }

    function makeStreamCallbacks(stream: import('./ttsPlayer').TtsPlayerCallbacks['stream']) {
        const captions: Array<string | null> = [];
        const cb = makeCallbacks();
        return {
            ...cb,
            captions,
            onUtteranceChange: (t: string | null) => captions.push(t),
            stream,
        };
    }

    it('plays sentence by sentence with per-sentence captions', async () => {
        const { ctx, sources } = makeFakeCtx();
        mockedGetCtx.mockReturnValue(ctx);
        const { stream, openStream, sentenceDeferreds, outcomeDeferred } = makeStream();
        const cb = makeStreamCallbacks(stream);
        const player = new TtsPlayer(cb);

        player.enqueue({ id: 'a', text: TWO_SENTENCES });
        await flush();
        expect(stream.mintToken).toHaveBeenCalledTimes(1);
        expect(openStream).toHaveBeenCalledTimes(1);
        expect(openStream.mock.calls[0][0].sentences).toEqual([S1, S2]);

        sentenceDeferreds[0].resolve(new Uint8Array([1]));
        await flush();
        expect(sources.length).toBe(1); // sentence 0 playing
        expect(cb.captions).toContain(S1);

        sources[0].onended?.();
        sentenceDeferreds[1].resolve(new Uint8Array([2]));
        outcomeDeferred.resolve({ kind: 'complete' });
        await flush();
        expect(sources.length).toBe(2);
        expect(cb.captions).toContain(S2);

        sources[1].onended?.();
        await flush();
        expect(cb.synthesize).not.toHaveBeenCalled(); // HTTP path never used
        expect(cb.speakingLog[cb.speakingLog.length - 1]).toBe(false);
        player.dispose();
    });

    it('mint unsupported → latches the gate and falls back to HTTP whole-clip', async () => {
        const { ctx, sources } = makeFakeCtx();
        mockedGetCtx.mockReturnValue(ctx);
        const { stream } = makeStream({
            mintToken: vi.fn(async () => ({ kind: 'unsupported' as const, status: 404 })),
        });
        const cb = makeStreamCallbacks(stream);
        const player = new TtsPlayer(cb);

        player.enqueue({ id: 'a', text: TWO_SENTENCES });
        await flush();
        expect(stream.disable).toHaveBeenCalled();
        expect(cb.synthesize).toHaveBeenCalledWith(TWO_SENTENCES);
        expect(sources.length).toBe(1);

        // next utterance skips minting entirely (gate is latched)
        sources[0].onended?.();
        await flush();
        player.enqueue({ id: 'b', text: TWO_SENTENCES });
        await flush();
        expect(stream.mintToken).toHaveBeenCalledTimes(1);
        expect(cb.synthesize).toHaveBeenCalledTimes(2);
        player.dispose();
    });

    it('mint transient error → HTTP fallback WITHOUT latching the gate', async () => {
        const { ctx, sources } = makeFakeCtx();
        mockedGetCtx.mockReturnValue(ctx);
        const { stream } = makeStream({
            mintToken: vi.fn(async () => ({ kind: 'error' as const })),
        });
        const cb = makeStreamCallbacks(stream);
        const player = new TtsPlayer(cb);

        player.enqueue({ id: 'a', text: TWO_SENTENCES });
        await flush();
        expect(stream.disable).not.toHaveBeenCalled();
        expect(cb.synthesize).toHaveBeenCalledWith(TWO_SENTENCES);
        expect(sources.length).toBe(1);
        player.dispose();
    });

    it('connect-level failure (sentence 0 null, failedAt 0) → gate + HTTP fallback', async () => {
        const { ctx, sources } = makeFakeCtx();
        mockedGetCtx.mockReturnValue(ctx);
        const { stream, sentenceDeferreds, outcomeDeferred } = makeStream();
        const cb = makeStreamCallbacks(stream);
        const player = new TtsPlayer(cb);

        player.enqueue({ id: 'a', text: TWO_SENTENCES });
        await flush();
        sentenceDeferreds[0].resolve(null);
        sentenceDeferreds[1].resolve(null);
        outcomeDeferred.resolve({ kind: 'failed', failedAt: 0 });
        await flush();
        expect(stream.disable).toHaveBeenCalled();
        expect(cb.synthesize).toHaveBeenCalledWith(TWO_SENTENCES);
        expect(sources.length).toBe(1);
        player.dispose();
    });

    it('mid-stream failure → remainder is spoken over HTTP (already-played audio not repeated)', async () => {
        const { ctx, sources } = makeFakeCtx();
        mockedGetCtx.mockReturnValue(ctx);
        const { stream, sentenceDeferreds, outcomeDeferred } = makeStream();
        const cb = makeStreamCallbacks(stream);
        const player = new TtsPlayer(cb);

        player.enqueue({ id: 'a', text: TWO_SENTENCES });
        await flush();
        sentenceDeferreds[0].resolve(new Uint8Array([1]));
        await flush();
        expect(sources.length).toBe(1);
        sources[0].onended?.();
        sentenceDeferreds[1].resolve(null); // failure after sentence 0 played
        outcomeDeferred.resolve({ kind: 'failed', failedAt: 1 });
        await flush();
        expect(cb.synthesize).toHaveBeenCalledTimes(1);
        expect(cb.synthesize).toHaveBeenCalledWith(S2); // only the remainder
        expect(stream.disable).not.toHaveBeenCalled();
        expect(sources.length).toBe(2);
        player.dispose();
    });

    it('empty sentence audio (alignment-less attribution) is skipped, not treated as failure', async () => {
        const { ctx, sources } = makeFakeCtx();
        mockedGetCtx.mockReturnValue(ctx);
        const { stream, sentenceDeferreds, outcomeDeferred } = makeStream();
        const cb = makeStreamCallbacks(stream);
        const player = new TtsPlayer(cb);

        player.enqueue({ id: 'a', text: TWO_SENTENCES });
        await flush();
        sentenceDeferreds[0].resolve(new Uint8Array([1, 2]));
        sentenceDeferreds[1].resolve(new Uint8Array(0)); // empty = attributed to sentence 0
        outcomeDeferred.resolve({ kind: 'complete' });
        await flush();
        expect(sources.length).toBe(1);
        sources[0].onended?.();
        await flush();
        expect(cb.synthesize).not.toHaveBeenCalled();
        expect(cb.speakingLog[cb.speakingLog.length - 1]).toBe(false);
        player.dispose();
    });

    it('stop() during streaming aborts the socket and does NOT fall back to HTTP', async () => {
        const { ctx, sources } = makeFakeCtx();
        mockedGetCtx.mockReturnValue(ctx);
        const { stream, sentenceDeferreds, abort } = makeStream();
        const cb = makeStreamCallbacks(stream);
        const player = new TtsPlayer(cb);

        player.enqueue({ id: 'a', text: TWO_SENTENCES });
        await flush();
        sentenceDeferreds[0].resolve(new Uint8Array([1]));
        await flush();
        expect(sources.length).toBe(1); // sentence 0 playing

        player.stop();
        await flush();
        expect(abort).toHaveBeenCalled();
        expect(cb.synthesize).not.toHaveBeenCalled();

        // pump stays live: a fresh utterance still plays
        player.enqueue({ id: 'b', text: 'And one more sentence to speak.' });
        await flush();
        expect(stream.mintToken).toHaveBeenCalledTimes(2);
        player.dispose();
    });
});

describe('TtsPlayer suspended-context resume (W4)', () => {
    it('resumes a suspended context before playing instead of skipping', async () => {
        const { ctx, raw, sources } = makeFakeCtx('suspended');
        mockedGetCtx.mockReturnValue(ctx);
        const cb = makeCallbacks();
        const player = new TtsPlayer(cb);

        player.enqueue({ id: 'a', text: 'after interruption' });
        await flush();

        expect(raw.resume).toHaveBeenCalled();
        expect(cb.synthesize).toHaveBeenCalledTimes(1);
        expect(sources.length).toBe(1); // playback proceeded after resume
        player.dispose();
    });

    it('skips the utterance silently when resume() cannot get the context running', async () => {
        const { ctx, raw, sources } = makeFakeCtx('suspended');
        raw.resume = vi.fn(async () => {
            /* stays suspended */
        });
        mockedGetCtx.mockReturnValue(ctx);
        const cb = makeCallbacks();
        const player = new TtsPlayer(cb);

        player.enqueue({ id: 'a', text: 'still locked' });
        await flush();

        expect(raw.resume).toHaveBeenCalled();
        expect(cb.synthesize).not.toHaveBeenCalled();
        expect(sources.length).toBe(0);
        // pump is idle again — speaking ends false
        expect(cb.speakingLog[cb.speakingLog.length - 1]).toBe(false);
        player.dispose();
    });
});
