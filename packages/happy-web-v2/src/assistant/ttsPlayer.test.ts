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
