/**
 * Pure helpers for the running-state indicator (B-310).
 *
 * Split out from the component because every one of these has a way to be
 * subtly wrong that only a test catches: a verb that changes on every render
 * (so the word flickers while the model works), a spinner frame derived from
 * an unstable clock, a token count that reads "0 tokens" when the CLI simply
 * has not reported yet.
 */

import { vibingMessages } from '@/utils/vibingMessages';
import { formatTokens } from './format';

/** Claude Code's spinner glyphs, in its order. */
export const SPARK_FRAMES = ['·', '✢', '✳', '∗', '✻', '✽'] as const;
export const SPARK_FRAME_MS = 120;
/** How long one verb stays on screen. Short enough to feel alive, long enough
 *  to read. */
export const VERB_ROTATE_MS = 4_000;

export function sparkFrameAt(elapsedMs: number): string {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return SPARK_FRAMES[2];
    return SPARK_FRAMES[Math.floor(elapsedMs / SPARK_FRAME_MS) % SPARK_FRAMES.length]!;
}

/** Stable per-session offset so two sessions running side by side don't chant
 *  the same word in lockstep. */
function seedOf(sessionId: string): number {
    let hash = 0;
    for (let i = 0; i < sessionId.length; i += 1) {
        hash = (hash * 31 + sessionId.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

/**
 * The verb shown at `elapsedMs` into the current run. Derived from elapsed
 * time rather than picked at random on mount, so a re-render (and there are
 * many — the timer ticks every second) never changes the word mid-step.
 */
export function vibingVerbAt(sessionId: string, elapsedMs: number): string {
    const step = Math.max(0, Math.floor(elapsedMs / VERB_ROTATE_MS));
    const index = (seedOf(sessionId) + step) % vibingMessages.length;
    return vibingMessages[index]!;
}

export type LiveStatusInput = {
    thinkingTokens?: number;
    outputTokens?: number;
};

/**
 * The quantified suffix: `14s · ↑ 1.2k tokens`. Token counts only appear once
 * the CLI actually reports them, so a session driven by an older CLI degrades
 * to exactly today's "elapsed only" line instead of claiming zero.
 */
export function liveStatusDetail(input: LiveStatusInput, elapsedLabel: string): string[] {
    const parts = [elapsedLabel];
    // Thinking tokens describe the phase the user is waiting through; output
    // tokens only become the more informative number once text is flowing.
    const tokens = input.outputTokens && input.outputTokens > 0
        ? input.outputTokens
        : input.thinkingTokens && input.thinkingTokens > 0
            ? input.thinkingTokens
            : null;
    if (tokens !== null) parts.push(`↑ ${formatTokens(tokens)} tokens`);
    return parts;
}
