/**
 * TtsPlayer — AudioContext-based sequential playback of assistant replies.
 *
 * fetch whole clip → decodeAudioData → BufferSourceNode, one at a time, in
 * ttsQueue order. Deliberately NOT speechSynthesis (broken/robotic on iOS,
 * no server voices) and NOT a streaming `<audio src>` (iOS buffering stalls);
 * whole-clip decode is the reliable path for short utterances.
 *
 * All queue/dedupe/stop SEMANTICS live in ttsQueue.ts (pure, unit-tested);
 * this class only executes effects.
 */

import type { TtsSynthesisResult } from '@/sync/apiVoice';
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
import { getAssistantAudioContext } from './iosAudioUnlock';

export interface TtsPlayerCallbacks {
    /** POST /v1/voice/tts wrapper (bound with credentials + voice settings) */
    synthesize: (text: string) => Promise<TtsSynthesisResult>;
    /** speaking indicator (drives the logo + store) */
    onSpeakingChange: (speaking: boolean) => void;
    /** server said 404/501 — caller flips to pure-text mode */
    onUnsupported: () => void;
}

export class TtsPlayer {
    private state: TtsQueueState = ttsQueueInitial;
    private source: AudioBufferSourceNode | null = null;
    private pumping = false;
    private disposed = false;
    /** resolver of the in-flight playOne() playback promise (null when idle) */
    private playbackDone: (() => void) | null = null;

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
                await this.playOne(next);
                this.state = ttsFinishCurrent(this.state);
            }
        } finally {
            this.pumping = false;
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

        const result = await this.callbacks.synthesize(utterance.text);
        if (this.disposed) return;
        if (result.kind === 'unsupported') {
            this.callbacks.onUnsupported();
            return;
        }
        if (result.kind !== 'ok') return; // rate-limited / error → skip this utterance

        // stop() may have raced the fetch — playingId was cleared, don't play
        if (this.state.playingId !== utterance.id) return;

        let buffer: AudioBuffer;
        try {
            buffer = await ctx.decodeAudioData(result.data);
        } catch {
            return;
        }
        if (this.disposed || this.state.playingId !== utterance.id) return;

        await new Promise<void>((resolve) => {
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
