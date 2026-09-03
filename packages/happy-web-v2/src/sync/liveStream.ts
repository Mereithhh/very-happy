/**
 * liveStream — the DRAFT of what a Claude SDK session is generating right now
 * (B-309).
 *
 * Everything here is deliberately outside the message pipeline: drafts never
 * enter `messagesMap`, never reach the reducer, never get a seq, never survive
 * a reload. They exist for one reason — before this channel the web had
 * nothing to show between "turn started" and "an entire assistant message
 * landed", so a 30-second thinking phase was 30 seconds of a pulsing dot while
 * the terminal showed the model thinking out loud the whole time.
 *
 * The persisted stream stays the source of truth. A draft's only job is to be
 * replaced by it: each block carries the `streamKey` the eventual envelope
 * will also carry, so the swap happens inside one render instead of the draft
 * blinking out and the real message blinking in.
 *
 * What actually arrives: assistant TEXT, live. Claude's reasoning is redacted
 * by the API — `thinking_delta` carries an empty string and even the persisted
 * thinking block is empty (measured 2026-09-03) — so a thinking draft shows up
 * only as the token counter in the status bar. The thinking branch here is
 * real and tested; it simply has nothing to render until the API unredacts.
 *
 * Frames are lossy by construction (relayed `volatile`, dropped while
 * disconnected, rate-limited on the server), so every transition here must
 * tolerate gaps: a delta for an unknown block opens it, a block that never
 * ends is swept, and a draft nothing ever claims expires.
 */

import type { SessionStreamFrame } from '@slopus/happy-wire';

/** How long an unclaimed draft survives after its turn ended. Long enough to
 *  cover the persisted message's trip (HTTP + a write transaction + whatever
 *  the CLI↔server distance costs), short enough that a draft the transaction
 *  dropped does not linger as a ghost. */
export const DRAFT_SWEEP_DELAY_MS = 1_500;
/** Backstop for a turn whose end frame never arrived (CLI killed mid-turn). */
export const DRAFT_MAX_AGE_MS = 5 * 60_000;
/**
 * How long a FINISHED block waits to be claimed before it is assumed orphaned.
 *
 * The SDK retries mid-stream (stall, 529, refusal fallback) by abandoning the
 * message it was writing and starting a fresh one with a new id. The abandoned
 * blocks are never persisted, so no `streamKey` ever claims them — without
 * this they would sit on screen next to the retry's real answer until the turn
 * ended. A persisted message normally lands well inside a second, so ten is
 * generous for "this one is never coming".
 */
export const ORPHAN_BLOCK_MS = 10_000;

export type LiveStreamBlock = {
    /** `"<api message id>:<content block index>"` — matches the envelope's `streamKey`. */
    key: string;
    kind: 'text' | 'thinking';
    text: string;
    /** The SDK closed this block; no more deltas are coming. */
    done: boolean;
    /** When it closed, for the orphan check. */
    doneAt: number | null;
};

export type LiveStreamProgress = {
    thinkingTokens?: number;
    outputTokens?: number;
    /** A phase worth naming while it lasts (the status bar shows it). */
    status?: 'requesting' | 'compacting';
};

export type LiveStreamState = {
    blocks: LiveStreamBlock[];
    progress: LiveStreamProgress;
    /** Last frame arrival, for the max-age backstop. */
    updatedAt: number;
    /** Set when the turn ends; blocks still unclaimed after it are dropped. */
    sweepAt: number | null;
    /** Draft identities a persisted message already superseded, so a frame
     *  that arrives after its own message cannot repaint it. */
    claimedKeys: ReadonlySet<string>;
};

const NO_CLAIMS: ReadonlySet<string> = new Set();

export const EMPTY_LIVE_STREAM: LiveStreamState = {
    blocks: [],
    progress: {},
    updatedAt: 0,
    sweepAt: null,
    claimedKeys: NO_CLAIMS,
};

function blockKey(mid: string, idx: number): string {
    return `${mid}:${idx}`;
}

/** Forget finished blocks no persisted message ever claimed (see ORPHAN_BLOCK_MS). */
function dropOrphans(blocks: readonly LiveStreamBlock[], now: number): LiveStreamBlock[] {
    return blocks.filter((block) => !(block.done && block.doneAt !== null && now - block.doneAt >= ORPHAN_BLOCK_MS));
}

/**
 * Fold one frame into the session's draft. Pure — the caller supplies `now`
 * and owns the sweep timer.
 */
export function applyStreamFrame(
    previous: LiveStreamState | undefined,
    frame: SessionStreamFrame,
    now: number,
): LiveStreamState {
    // A draft older than the backstop belongs to a turn that died without
    // saying so. Start clean rather than appending to a stale transcript.
    const base = previous && now - previous.updatedAt < DRAFT_MAX_AGE_MS ? previous : EMPTY_LIVE_STREAM;

    switch (frame.t) {
        case 'block-start': {
            const key = blockKey(frame.mid, frame.idx);
            if (base.claimedKeys.has(key)) return base;
            // A block opening with nothing accumulated is a NEW turn starting.
            // Progress is per-turn, and a lost `turn-end` would otherwise leave
            // the previous turn's token count on screen as if it were this
            // turn's.
            const startingTurn = base.blocks.length === 0;
            const progress = startingTurn ? {} : base.progress;
            const claimedKeys = startingTurn ? NO_CLAIMS : base.claimedKeys;
            if (base.blocks.some((block) => block.key === key)) {
                return { ...base, progress, claimedKeys, updatedAt: now, sweepAt: null };
            }
            return {
                ...base,
                progress,
                claimedKeys,
                blocks: [...base.blocks, { key, kind: frame.kind, text: '', done: false, doneAt: null }],
                updatedAt: now,
                sweepAt: null,
            };
        }
        case 'block-delta': {
            const key = blockKey(frame.mid, frame.idx);
            if (base.claimedKeys.has(key)) return base;
            const blocks = dropOrphans(base.blocks, now);
            const index = blocks.findIndex((block) => block.key === key);
            if (index === -1) {
                // The start frame was lost. Open the block rather than drop the
                // text: guessing 'text' is right far more often than showing
                // nothing, and the persisted message corrects it either way.
                return {
                    ...base,
                    blocks: [...blocks, { key, kind: 'text', text: frame.text, done: false, doneAt: null }],
                    updatedAt: now,
                    sweepAt: null,
                };
            }
            blocks[index] = { ...blocks[index]!, text: blocks[index]!.text + frame.text };
            return { ...base, blocks, updatedAt: now, sweepAt: null };
        }
        case 'block-end': {
            const key = blockKey(frame.mid, frame.idx);
            const index = base.blocks.findIndex((block) => block.key === key);
            // sweepAt is cleared here and in `progress` too, not only on
            // start/delta: ANY frame but `turn-end` means the turn is still
            // producing. A turn that goes quiet mid-tool-call sends only
            // progress frames, and an armed sweep would then delete the whole
            // accumulated answer 1.5s later — the next delta would re-open the
            // block from empty and the answer would visibly truncate.
            if (index === -1) return { ...base, updatedAt: now, sweepAt: null };
            const blocks = dropOrphans(base.blocks, now);
            const target = blocks.findIndex((block) => block.key === key);
            if (target === -1) return { ...base, blocks, updatedAt: now, sweepAt: null };
            blocks[target] = { ...blocks[target]!, done: true, doneAt: now };
            return { ...base, blocks, updatedAt: now, sweepAt: null };
        }
        case 'progress': {
            return {
                ...base,
                progress: {
                    // Merge, don't replace: the CLI sends whichever fields it
                    // learned this window, and a frame without `thinkingTokens`
                    // means "no news", not "back to zero".
                    ...base.progress,
                    ...(frame.thinkingTokens !== undefined ? { thinkingTokens: frame.thinkingTokens } : {}),
                    ...(frame.outputTokens !== undefined ? { outputTokens: frame.outputTokens } : {}),
                    // `status` replaces unconditionally (unlike the token
                    // fields): a frame without one means the phase ENDED, and
                    // merging would leave "Compacting" on screen forever.
                    status: frame.status,
                },
                updatedAt: now,
                sweepAt: null,
            };
        }
        case 'turn-end': {
            // Blocks are NOT dropped here: the persisted messages are still in
            // flight, and clearing now would blank the transcript's tail for
            // however long the write takes. Arm the sweep instead — and close
            // every block, so nothing keeps a "still typing" caret blinking
            // over text that is finished.
            return {
                ...base,
                blocks: base.blocks.map((block) => (block.done ? block : { ...block, done: true, doneAt: now })),
                progress: {},
                updatedAt: now,
                sweepAt: now + DRAFT_SWEEP_DELAY_MS,
            };
        }
    }
}

/**
 * Drop the drafts that just-persisted messages superseded. Called with every
 * `streamKey` in an incoming batch; keys that match nothing are ignored (a
 * reload replaying history, a message from a different device).
 */
export function claimStreamKeys(
    previous: LiveStreamState | undefined,
    keys: readonly string[],
): LiveStreamState | undefined {
    if (!previous || keys.length === 0) return previous;
    // Remember the claim even when no block matches. The persisted message can
    // beat its own draft to the client — messages ride the (possibly
    // region-local) relay while drafts always go through the origin server —
    // and without this the late frames would paint an answer that is already
    // on screen and leave it duplicated until the sweep.
    const claimedKeys = new Set(previous.claimedKeys);
    for (const key of keys) claimedKeys.add(key);
    const blocks = previous.blocks.filter((block) => !claimedKeys.has(block.key));
    if (blocks.length === previous.blocks.length && claimedKeys.size === previous.claimedKeys.size) {
        return previous;
    }
    return { ...previous, blocks, claimedKeys };
}

/**
 * Apply the armed sweep. Returns undefined when nothing is left worth keeping,
 * so the caller can drop the session's entry entirely.
 */
export function sweepDrafts(
    previous: LiveStreamState | undefined,
    now: number,
): LiveStreamState | undefined {
    if (!previous) return undefined;
    const expired = now - previous.updatedAt >= DRAFT_MAX_AGE_MS;
    const swept = previous.sweepAt !== null && now >= previous.sweepAt;
    if (!expired && !swept) return previous;
    return undefined;
}

/** Collect the draft identities carried by a batch of persisted messages. */
export function streamKeysOf(messages: readonly { streamKey?: string }[]): string[] {
    const keys: string[] = [];
    for (const message of messages) {
        if (typeof message.streamKey === 'string' && message.streamKey.length > 0) {
            keys.push(message.streamKey);
        }
    }
    return keys;
}
