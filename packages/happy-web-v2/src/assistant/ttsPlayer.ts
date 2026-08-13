/**
 * TtsPlayer — AudioContext-based sequential playback of assistant replies.
 *
 * fetch whole clip → decodeAudioData → BufferSourceNode, one at a time, in
 * ttsQueue order. Deliberately NOT speechSynthesis (broken/robotic on iOS,
 * no server voices) and NOT a streaming `<audio src>` (iOS buffering stalls);
 * whole-clip decode is the reliable path for short utterances.
 *
 * B-069 adds a STREAMING synthesis path: when the optional `stream` callbacks
 * are wired, an utterance is split into sentences, synthesized over a
 * browser-direct ElevenLabs WebSocket (ttsStream.ts), and each sentence's mp3
 * is decoded and played through the SAME queue/stop/caption machinery —
 * captions advance per sentence, first audio lands as soon as sentence 0 is
 * synthesized. Every failure falls back to the HTTP whole-clip path for the
 * turn (mint 404/501 or connect failure additionally latch the per-visit
 * "stream disabled" gate via stream.disable()).
 *
 * All queue/dedupe/stop SEMANTICS live in ttsQueue.ts (pure, unit-tested);
 * this class only executes effects.
 */

import type { TtsSynthesisResult, VoiceTokenMintResult } from '@/sync/apiVoice';
import {
    ttsQueueInitial,
    ttsEnqueue,
    ttsStartNext,
    ttsFinishCurrent,
    ttsStopAll,
    ttsIsActive,
    type TtsQueueState,
    type TtsUtterance,
} from './ttsQueue';
import { splitIntoSentences, type TtsStreamHandle } from './ttsStream';
import { getAssistantAudioContext } from './iosAudioUnlock';

export interface TtsStreamCallbacks {
    /** POST /v1/voice/token wrapper (bound with credentials) */
    mintToken: () => Promise<VoiceTokenMintResult>;
    /** open the stream-input socket (ttsStream.startTtsStream; injectable) */
    openStream: (opts: { token: string; sentences: string[]; voiceId?: string }) => TtsStreamHandle;
    /** voice for browser-direct synthesis (undefined = ElevenLabs default) */
    getVoiceId: () => string | undefined;
    /** per-visit sticky gate — true means don't even try the WS path */
    isDisabled: () => boolean;
    /** latch the gate (mint said 404/501, or the socket refused to connect) */
    disable: () => void;
}

export interface TtsPlayerCallbacks {
    /** POST /v1/voice/tts wrapper (bound with credentials + voice settings) */
    synthesize: (text: string) => Promise<TtsSynthesisResult>;
    /** speaking indicator (drives the logo + store) */
    onSpeakingChange: (speaking: boolean) => void;
    /** server said 404/501 — caller flips to pure-text mode */
    onUnsupported: () => void;
    /** B-059 captions: text of the utterance being spoken, null when idle */
    onUtteranceChange?: (text: string | null) => void;
    /** B-069: streaming synthesis path (absent = HTTP whole-clip only) */
    stream?: TtsStreamCallbacks;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export class TtsPlayer {
    private state: TtsQueueState = ttsQueueInitial;
    private source: AudioBufferSourceNode | null = null;
    private pumping = false;
    private disposed = false;
    /** resolver of the in-flight playOne() playback promise (null when idle) */
    private playbackDone: (() => void) | null = null;
    /** the streaming synthesis in flight, aborted by stop() */
    private activeStream: TtsStreamHandle | null = null;

    constructor(private callbacks: TtsPlayerCallbacks) {}

    enqueue(utterance: TtsUtterance): void {
        if (this.disposed) return;
        const before = this.state;
        this.state = ttsEnqueue(this.state, utterance);
        if (this.state !== before) {
            this.callbacks.onSpeakingChange(ttsIsActive(this.state));
            void this.pump();
        }
    }

    /** Stop playback and drop the queue (dedupe memory survives). */
    stop(): void {
        this.state = ttsStopAll(this.state);
        if (this.activeStream) {
            // resolves the pending sentence promises to null, so the stream
            // loop in playStreamed() wakes up and sees playingId is gone
            this.activeStream.abort();
            this.activeStream = null;
        }
        if (this.source) {
            try {
                this.source.onended = null;
                this.source.stop();
            } catch {
                // already stopped
            }
            this.source = null;
        }
        // CRITICAL: onended was nulled above, so the promise playOne() is
        // awaiting would otherwise never settle — the pump would deadlock and
        // every future enqueue would be silently dropped. Resolve it here.
        if (this.playbackDone) {
            const done = this.playbackDone;
            this.playbackDone = null;
            done();
        }
        this.callbacks.onSpeakingChange(false);
    }

    dispose(): void {
        this.stop();
        this.disposed = true;
    }

    private async pump(): Promise<void> {
        if (this.pumping || this.disposed) return;
        this.pumping = true;
        try {
            // sequential loop — one utterance fully finishes before the next
            for (;;) {
                const { state, next } = ttsStartNext(this.state);
                if (!next) break;
                this.state = state;
                this.callbacks.onUtteranceChange?.(next.text);
                await this.playOne(next);
                this.state = ttsFinishCurrent(this.state);
            }
        } finally {
            this.pumping = false;
            this.callbacks.onUtteranceChange?.(null);
            this.callbacks.onSpeakingChange(ttsIsActive(this.state));
        }
    }

    private async playOne(utterance: TtsUtterance): Promise<void> {
        const ctx = getAssistantAudioContext();
        if (!ctx) return; // Web Audio unavailable — skip silently
        if (ctx.state !== 'running') {
            // iOS suspends the context on interruptions (phone call / Siri).
            // The page keeps its unlock privilege, so resume() succeeds without
            // a fresh gesture — try it before giving up on the utterance.
            try {
                await ctx.resume();
            } catch {
                // fall through; state check below decides
            }
            if ((ctx.state as AudioContextState) !== 'running') return;
        }

        const stream = this.callbacks.stream;
        if (stream && !stream.isDisabled()) {
            const handled = await this.playStreamed(utterance, ctx, stream);
            if (handled) return;
            if (this.disposed || this.state.playingId !== utterance.id) return;
            // restore the whole-utterance caption for the HTTP fallback
            this.callbacks.onUtteranceChange?.(utterance.text);
        }

        await this.playWhole(utterance.text, utterance.id, ctx);
    }

    /**
     * Streaming path. Returns true when the utterance was handled (played,
     * stopped, or recovered via a partial HTTP fallback); false when NOTHING
     * was played and the caller should run the whole-clip HTTP path.
     */
    private async playStreamed(
        utterance: TtsUtterance,
        ctx: AudioContext,
        stream: TtsStreamCallbacks,
    ): Promise<boolean> {
        const sentences = splitIntoSentences(utterance.text);
        if (sentences.length === 0) return true; // nothing speakable

        const mint = await stream.mintToken();
        if (this.disposed || this.state.playingId !== utterance.id) return true; // stopped meanwhile
        if (mint.kind === 'unsupported') {
            // old server (404) / voice not configured (501) — don't retry this
            // visit; the HTTP path owns the user-facing unsupported semantics
            stream.disable();
            return false;
        }
        if (mint.kind === 'error') return false; // transient — this turn only

        const handle = stream.openStream({
            token: mint.token,
            sentences,
            voiceId: stream.getVoiceId(),
        });
        this.activeStream = handle;
        try {
            for (let i = 0; i < sentences.length; i++) {
                const audio = await handle.sentenceAudio[i];
                if (this.disposed || this.state.playingId !== utterance.id) return true; // stopped
                if (audio === null) {
                    // stream failed / aborted before this sentence arrived
                    if (i === 0) {
                        // nothing played yet → let the whole-clip path handle it;
                        // a connect-level failure also latches the gate
                        const outcome = await handle.outcome;
                        if (outcome.kind === 'failed' && outcome.failedAt === 0) stream.disable();
                        return false;
                    }
                    // mid-stream failure — speak the remainder over HTTP
                    const rest = sentences.slice(i).join(' ');
                    this.callbacks.onUtteranceChange?.(rest);
                    await this.playWhole(rest, utterance.id, ctx);
                    return true;
                }
                if (audio.length === 0) continue; // attributed to an earlier sentence
                this.callbacks.onUtteranceChange?.(sentences[i]);
                await this.playBytes(ctx, audio, utterance.id);
            }
            return true;
        } finally {
            if (this.activeStream === handle) this.activeStream = null;
            handle.abort(); // no-op when already complete
        }
    }

    /** HTTP whole-clip synthesis + playback (the pre-B-069 path). */
    private async playWhole(text: string, utteranceId: string, ctx: AudioContext): Promise<void> {
        const result = await this.callbacks.synthesize(text);
        if (this.disposed) return;
        if (result.kind === 'unsupported') {
            this.callbacks.onUnsupported();
            return;
        }
        if (result.kind !== 'ok') return; // rate-limited / error → skip this utterance

        // stop() may have raced the fetch — playingId was cleared, don't play
        if (this.state.playingId !== utteranceId) return;

        let buffer: AudioBuffer;
        try {
            buffer = await ctx.decodeAudioData(result.data);
        } catch {
            return;
        }
        if (this.disposed || this.state.playingId !== utteranceId) return;
        await this.playBuffer(ctx, buffer);
    }

    /** Decode raw mp3 bytes and play them (streaming sentence). */
    private async playBytes(ctx: AudioContext, bytes: Uint8Array, utteranceId: string): Promise<void> {
        let buffer: AudioBuffer;
        try {
            buffer = await ctx.decodeAudioData(toArrayBuffer(bytes));
        } catch {
            return;
        }
        if (this.disposed || this.state.playingId !== utteranceId) return;
        await this.playBuffer(ctx, buffer);
    }

    private playBuffer(ctx: AudioContext, buffer: AudioBuffer): Promise<void> {
        return new Promise<void>((resolve) => {
            const finish = () => {
                if (this.playbackDone === finish) this.playbackDone = null;
                resolve(); // resolving twice is a no-op, so stop() racing onended is safe
            };
            this.playbackDone = finish;
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(ctx.destination);
            source.onended = () => {
                if (this.source === source) this.source = null;
                finish();
            };
            this.source = source;
            try {
                source.start();
            } catch {
                this.source = null;
                finish();
            }
        });
    }
}
