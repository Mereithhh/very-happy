/**
 * StreamRelay — turns the SDK's token-level firehose into a trickle of
 * `SessionStreamFrame`s the web can paint live (B-309).
 *
 * Why this exists at all: until now the ONLY thing the web saw during a turn
 * was a 2s `session-alive` heartbeat carrying a single boolean. Everything
 * with actual content — `stream_event` partials, `system/thinking_tokens`,
 * `tool_progress` — was dropped (sdkToLogConverter returned null for the
 * first, OutgoingMessageQueue's `type !== 'system'` filter ate the rest). So a
 * 30-second thinking phase was 30 seconds of a pulsing dot, then an entire
 * assistant message at once. The terminal, streaming straight from the API,
 * showed it word by word the whole time.
 *
 * Design constraints that shaped this module:
 *
 *  - **Coalescing is mandatory, not an optimisation.** A model emits ~100
 *    deltas/second; relaying each one is a socket event per token. Deltas for
 *    one block are concatenated over an 80ms window and sent as a single
 *    frame. 80ms is below the threshold where the eye reads text as arriving
 *    in chunks, and it caps the event rate at ~12/s.
 *
 *  - **Thinking text is NOT available today, and that is upstream of us.**
 *    Measured against the SDK on 2026-09-03: `thinking_delta` frames arrive
 *    with `thinking: ""` and the FINAL assistant message's thinking block is
 *    empty too — the API redacts reasoning and streams only
 *    `estimated_tokens`. So what makes a turn watchable is the assistant TEXT
 *    stream (345 deltas over 20s in that measurement, first one at 2.6s
 *    against 20s of nothing before this channel existed) plus the thinking
 *    token counter. The thinking_delta path below is still wired: if the API
 *    ever unredacts it, it starts working with no further change.
 *
 *  - **This is a lossy side channel.** Frames ride a `volatile` emit and are
 *    swept on turn end; the persisted envelope stream stays the source of
 *    truth. So dropping a frame must always be safe — never accumulate state
 *    the web could only reconstruct by replaying every frame.
 *
 *  - **No socket, no timers of its own beyond the flush window.** `send` and
 *    the clock are injected so the whole thing is unit-testable without a
 *    server, which is how the ordering guarantees below stay pinned.
 *
 * Ordering guarantee: a block's `block-start` is emitted before any of its
 * deltas, and `block-end` after the last one, because pending text is always
 * flushed before a lifecycle frame goes out.
 */

import type { SessionStreamFrame } from '@slopus/happy-wire';
import { STREAM_DELTA_MAX_CHARS } from '@slopus/happy-wire';

/** Delta coalescing window. See the module comment for why 80ms. */
export const STREAM_FLUSH_MS = 80;
/** Progress frames are pure UI garnish; a slower cadence is plenty. */
export const PROGRESS_FLUSH_MS = 250;
/**
 * Flush early once the pending text would encode past this many BYTES.
 *
 * The wire cap is in characters and the relay's is in bytes — for CJK those
 * differ by 3x, and encryption + base64 adds another ~4/3 on top. 16KB of
 * UTF-8 encodes to roughly 22KB, comfortably inside the relay's 64KB ceiling,
 * where 32K CJK *characters* would be ~128KB and get dropped by the server
 * with no error anywhere. Never let a frame we consider valid be one the
 * relay silently discards.
 */
export const STREAM_FLUSH_MAX_BYTES = 16 * 1024;

/** The subset of SDK frames this relay consumes. Kept structural (rather than
 *  importing the SDK unions) so tests can build frames by hand and so an SDK
 *  version bump cannot silently change what we accept. */
export type StreamRelayInput =
    | { type: 'stream_event'; event: unknown }
    | { type: 'system'; subtype: 'thinking_tokens'; estimated_tokens?: number }
    | { type: 'system'; subtype: 'status'; status?: string | null };

type PendingBlock = {
    mid: string;
    idx: number;
    text: string;
    /** Running UTF-8 size, so the byte check never re-encodes the buffer. */
    bytes: number;
};

type Progress = {
    thinkingTokens?: number;
    outputTokens?: number;
    status?: 'requesting' | 'compacting';
};

export type StreamRelayOptions = {
    send: (frame: SessionStreamFrame) => void;
    /** Injected for tests; defaults to real timers. */
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
    now?: () => number;
};

export class StreamRelay {
    private readonly send: (frame: SessionStreamFrame) => void;
    private readonly setTimer: (fn: () => void, ms: number) => unknown;
    private readonly clearTimer: (handle: unknown) => void;
    private readonly now: () => number;

    /** The block currently accumulating deltas. At most one is open at a time
     *  in practice; a switch flushes the previous one first, so out-of-order
     *  SDK frames degrade to "slightly chunkier", never to interleaved text. */
    private pending: PendingBlock | null = null;
    private flushHandle: unknown = null;

    private progress: Progress = {};
    private progressDirty = false;
    private progressHandle: unknown = null;

    /** Message id of the block currently open, so `content_block_delta` (which
     *  carries only an index) can be attributed. Reset per assistant message. */
    private currentMid: string | null = null;
    private openBlocks = new Set<number>();

    /** True while nothing has been ingested since the last sweep. Both the SDK
     *  `result` frame and the launcher's `finally` call endTurn (the second is
     *  the safety net for turns that die before producing a result), so
     *  without this a normal turn would emit two sweeps. */
    private idleSinceTurnEnd = true;

    constructor(options: StreamRelayOptions) {
        this.send = options.send;
        this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
        this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
        this.now = options.now ?? (() => Date.now());
    }

    /** Feed one SDK frame. Unknown shapes are ignored, never thrown on: this
     *  channel must not be able to take a turn down. */
    ingest(message: StreamRelayInput): void {
        this.idleSinceTurnEnd = false;
        try {
            if (message.type === 'stream_event') {
                this.ingestStreamEvent(message.event);
                return;
            }
            if (message.type === 'system' && message.subtype === 'thinking_tokens') {
                if (typeof message.estimated_tokens === 'number') {
                    this.setProgress({ thinkingTokens: message.estimated_tokens });
                }
                return;
            }
            if (message.type === 'system' && message.subtype === 'status') {
                const status = message.status === 'requesting' || message.status === 'compacting'
                    ? message.status
                    : undefined;
                // A null status means "no longer in a special phase" — clear it
                // rather than leaving a stale "Compacting" on screen forever.
                this.progress.status = status;
                this.progressDirty = true;
                this.scheduleProgress();
                return;
            }
        } catch {
            // Deliberately swallowed: a malformed partial is not worth a turn.
        }
    }

    /** The turn produced its result. Flushes everything and tells the web to
     *  sweep drafts that no persisted message ever claimed. */
    endTurn(): void {
        // Release timers before the early return, not after it. Today "idle"
        // implies "no timer", but that is an invariant two call sites happen to
        // maintain rather than something enforced here.
        if (this.idleSinceTurnEnd) {
            this.clearTimers();
            return;
        }
        this.idleSinceTurnEnd = true;
        this.flushPending();
        this.closeOpenBlocks();
        this.flushProgress();
        this.progress = {};
        this.currentMid = null;
        this.send({ t: 'turn-end' });
    }

    /** Release timers without emitting anything (session teardown). */
    dispose(): void {
        this.clearTimers();
        this.pending = null;
        this.openBlocks.clear();
    }

    private clearTimers(): void {
        if (this.flushHandle !== null) this.clearTimer(this.flushHandle);
        if (this.progressHandle !== null) this.clearTimer(this.progressHandle);
        this.flushHandle = null;
        this.progressHandle = null;
    }

    private ingestStreamEvent(event: unknown): void {
        const e = event as Record<string, any> | null;
        if (!e || typeof e.type !== 'string') return;

        if (e.type === 'message_start') {
            const mid = e.message?.id;
            // A new API message: whatever was open belonged to the previous one.
            this.flushPending();
            this.closeOpenBlocks();
            this.currentMid = typeof mid === 'string' && mid.length > 0 ? mid : null;
            return;
        }

        if (e.type === 'content_block_start') {
            const kind = e.content_block?.type === 'thinking'
                ? 'thinking'
                : e.content_block?.type === 'text'
                    ? 'text'
                    : null;
            // tool_use blocks stream their JSON args; those already show up as
            // real tool cards on the persisted path, so they are not drafted.
            if (!kind || !this.currentMid || typeof e.index !== 'number') return;
            this.flushPending();
            this.openBlocks.add(e.index);
            this.send({ t: 'block-start', mid: this.currentMid, idx: e.index, kind });
            return;
        }

        if (e.type === 'content_block_delta') {
            const delta = e.delta;
            const text = delta?.type === 'text_delta'
                ? delta.text
                : delta?.type === 'thinking_delta'
                    ? delta.thinking
                    : null;
            if (typeof text !== 'string' || text.length === 0) return;
            if (!this.currentMid || typeof e.index !== 'number') return;
            if (!this.openBlocks.has(e.index)) return;
            this.appendDelta(this.currentMid, e.index, text);
            return;
        }

        if (e.type === 'content_block_stop') {
            if (!this.currentMid || typeof e.index !== 'number') return;
            if (!this.openBlocks.has(e.index)) return;
            this.flushPending();
            this.openBlocks.delete(e.index);
            this.send({ t: 'block-end', mid: this.currentMid, idx: e.index });
            return;
        }

        if (e.type === 'message_delta') {
            const outputTokens = e.usage?.output_tokens;
            if (typeof outputTokens === 'number') {
                this.setProgress({ outputTokens });
            }
            return;
        }
    }

    private appendDelta(mid: string, idx: number, text: string): void {
        if (this.pending && (this.pending.mid !== mid || this.pending.idx !== idx)) {
            this.flushPending();
        }
        if (!this.pending) {
            this.pending = { mid, idx, text: '', bytes: 0 };
        }
        this.pending.text += text;
        this.pending.bytes += Buffer.byteLength(text, 'utf8');
        // Flush early on either limit. Bytes is the one that actually bites —
        // the relay measures bytes while the schema measures characters, and
        // CJK makes those differ by 3x (see STREAM_FLUSH_MAX_BYTES).
        if (this.pending.bytes >= STREAM_FLUSH_MAX_BYTES || this.pending.text.length >= STREAM_DELTA_MAX_CHARS) {
            this.flushPending();
            return;
        }
        if (this.flushHandle === null) {
            this.flushHandle = this.setTimer(() => {
                this.flushHandle = null;
                this.flushPending();
            }, STREAM_FLUSH_MS);
        }
    }

    private flushPending(): void {
        if (this.flushHandle !== null) {
            this.clearTimer(this.flushHandle);
            this.flushHandle = null;
        }
        const pending = this.pending;
        this.pending = null;
        if (!pending || pending.text.length === 0) return;
        this.send({ t: 'block-delta', mid: pending.mid, idx: pending.idx, text: pending.text });
    }

    /** Close blocks the SDK never stopped (interrupt, error, message switch) so
     *  the web's draft does not keep a blinking cursor forever. */
    private closeOpenBlocks(): void {
        if (!this.currentMid || this.openBlocks.size === 0) {
            this.openBlocks.clear();
            return;
        }
        for (const idx of [...this.openBlocks].sort((a, b) => a - b)) {
            this.send({ t: 'block-end', mid: this.currentMid, idx });
        }
        this.openBlocks.clear();
    }

    private setProgress(patch: Progress): void {
        this.progress = { ...this.progress, ...patch };
        this.progressDirty = true;
        this.scheduleProgress();
    }

    private scheduleProgress(): void {
        if (this.progressHandle !== null) return;
        this.progressHandle = this.setTimer(() => {
            this.progressHandle = null;
            this.flushProgress();
        }, PROGRESS_FLUSH_MS);
    }

    private flushProgress(): void {
        if (this.progressHandle !== null) {
            this.clearTimer(this.progressHandle);
            this.progressHandle = null;
        }
        if (!this.progressDirty) return;
        this.progressDirty = false;
        this.send({ t: 'progress', ...this.progress });
    }
}
