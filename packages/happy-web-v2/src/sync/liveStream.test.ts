import { describe, expect, it } from 'vitest';
import type { SessionStreamFrame } from '@slopus/happy-wire';
import {
    applyStreamFrame,
    claimStreamKeys,
    DRAFT_MAX_AGE_MS,
    DRAFT_SWEEP_DELAY_MS,
    EMPTY_LIVE_STREAM,
    ORPHAN_BLOCK_MS,
    streamKeysOf,
    sweepDrafts,
    type LiveStreamState,
} from './liveStream';

const T0 = 1_000_000;
const fold = (frames: SessionStreamFrame[], now = T0, from?: LiveStreamState) =>
    frames.reduce<LiveStreamState | undefined>((state, frame) => applyStreamFrame(state, frame, now), from);

describe('applyStreamFrame', () => {
    it('accumulates deltas into the block they belong to', () => {
        const state = fold([
            { t: 'block-start', mid: 'm1', idx: 0, kind: 'thinking' },
            { t: 'block-delta', mid: 'm1', idx: 0, text: 'Let me ' },
            { t: 'block-delta', mid: 'm1', idx: 0, text: 'check.' },
        ])!;
        expect(state.blocks).toEqual([{ key: 'm1:0', kind: 'thinking', text: 'Let me check.', done: false, doneAt: null }]);
    });

    it('keeps blocks in arrival order and marks only the ended one done', () => {
        const state = fold([
            { t: 'block-start', mid: 'm1', idx: 0, kind: 'thinking' },
            { t: 'block-delta', mid: 'm1', idx: 0, text: 'why' },
            { t: 'block-end', mid: 'm1', idx: 0 },
            { t: 'block-start', mid: 'm1', idx: 1, kind: 'text' },
            { t: 'block-delta', mid: 'm1', idx: 1, text: 'because' },
        ])!;
        expect(state.blocks.map((b) => [b.key, b.kind, b.done])).toEqual([
            ['m1:0', 'thinking', true],
            ['m1:1', 'text', false],
        ]);
    });

    it('opens a block for a delta whose start frame was lost rather than dropping text', () => {
        // Frames are relayed volatile and rate-limited: losing one must cost a
        // little fidelity, never a swallowed paragraph.
        const state = fold([{ t: 'block-delta', mid: 'm1', idx: 3, text: 'orphan' }])!;
        expect(state.blocks).toEqual([{ key: 'm1:3', kind: 'text', text: 'orphan', done: false, doneAt: null }]);
    });

    it('ignores a duplicate block-start instead of resetting accumulated text', () => {
        const state = fold([
            { t: 'block-start', mid: 'm1', idx: 0, kind: 'text' },
            { t: 'block-delta', mid: 'm1', idx: 0, text: 'kept' },
            { t: 'block-start', mid: 'm1', idx: 0, kind: 'text' },
        ])!;
        expect(state.blocks[0]!.text).toBe('kept');
    });

    it('merges progress fields — a frame without a field means "no news", not zero', () => {
        let state = applyStreamFrame(undefined, { t: 'progress', thinkingTokens: 500 }, T0);
        state = applyStreamFrame(state, { t: 'progress', outputTokens: 12 }, T0);
        expect(state.progress).toMatchObject({ thinkingTokens: 500, outputTokens: 12 });
    });

    it('clears a phase when the CLI stops reporting one', () => {
        let state = applyStreamFrame(undefined, { t: 'progress', status: 'compacting' }, T0);
        state = applyStreamFrame(state, { t: 'progress', outputTokens: 1 }, T0);
        expect(state.progress.status).toBeUndefined();
    });

    it('turn-end closes every block so no caret keeps blinking over finished text', () => {
        const state = fold([
            { t: 'block-start', mid: 'm1', idx: 0, kind: 'text' },
            { t: 'block-delta', mid: 'm1', idx: 0, text: 'done writing' },
            { t: 'turn-end' },
        ])!;
        expect(state.blocks.every((block) => block.done)).toBe(true);
    });

    it('a new turn opening its first block clears the previous turn\'s progress', () => {
        // Frames are lossy: lose a turn-end and the next turn would otherwise
        // open showing the previous turn's token count as if it were its own.
        const stale = applyStreamFrame(EMPTY_LIVE_STREAM, { t: 'progress', outputTokens: 4000 }, T0);
        const next = applyStreamFrame(stale, { t: 'block-start', mid: 'm2', idx: 0, kind: 'text' }, T0 + 10);
        expect(next.progress).toEqual({});
    });

    it('turn-end arms the sweep but KEEPS the blocks — the persisted message is still in flight', () => {
        const state = fold([
            { t: 'block-start', mid: 'm1', idx: 0, kind: 'text' },
            { t: 'block-delta', mid: 'm1', idx: 0, text: 'answer' },
            { t: 'turn-end' },
        ])!;
        expect(state.blocks).toHaveLength(1);
        expect(state.sweepAt).toBe(T0 + DRAFT_SWEEP_DELAY_MS);
        expect(state.progress).toEqual({});
    });

    it('disarms the sweep when a new turn starts streaming', () => {
        const ended = fold([{ t: 'block-start', mid: 'm1', idx: 0, kind: 'text' }, { t: 'turn-end' }])!;
        const resumed = applyStreamFrame(ended, { t: 'block-start', mid: 'm2', idx: 0, kind: 'text' }, T0 + 10);
        expect(resumed.sweepAt).toBeNull();
    });

    it('starts clean when the previous draft is older than the backstop', () => {
        const stale = fold([{ t: 'block-start', mid: 'm1', idx: 0, kind: 'text' }])!;
        const fresh = applyStreamFrame(stale, { t: 'block-start', mid: 'm2', idx: 0, kind: 'text' }, T0 + DRAFT_MAX_AGE_MS);
        expect(fresh.blocks.map((b) => b.key)).toEqual(['m2:0']);
    });
});

describe('claimStreamKeys', () => {
    it('removes exactly the drafts the persisted batch superseded', () => {
        const state = fold([
            { t: 'block-start', mid: 'm1', idx: 0, kind: 'thinking' },
            { t: 'block-start', mid: 'm1', idx: 1, kind: 'text' },
        ])!;
        const next = claimStreamKeys(state, ['m1:0'])!;
        expect(next.blocks.map((b) => b.key)).toEqual(['m1:1']);
    });

    it('returns the SAME object when there is nothing to record, so subscribers do not re-render', () => {
        const state = fold([{ t: 'block-start', mid: 'm1', idx: 0, kind: 'text' }])!;
        expect(claimStreamKeys(state, [])).toBe(state);
        expect(claimStreamKeys(undefined, ['m1:0'])).toBeUndefined();
        // Re-claiming an already-recorded key changes nothing either.
        const once = claimStreamKeys(state, ['m1:0'])!;
        expect(claimStreamKeys(once, ['m1:0'])).toBe(once);
    });

    it('remembers a claim that matched nothing, so a late frame cannot repaint it', () => {
        // Persisted messages ride the region-local relay while drafts always go
        // through the origin server, so a message can beat its own draft.
        // Without the memory, those frames would paint an answer that is
        // already on screen and leave it duplicated until the sweep.
        const landed = applyStreamFrame(EMPTY_LIVE_STREAM, { t: 'progress', outputTokens: 1 }, T0);
        const claimed = claimStreamKeys(landed, ['m1:0'])!;
        const late = [
            { t: 'block-start', mid: 'm1', idx: 0, kind: 'text' },
            { t: 'block-delta', mid: 'm1', idx: 0, text: 'already landed' },
        ].reduce((state, frame) => applyStreamFrame(state, frame as SessionStreamFrame, T0), claimed);

        expect(late.blocks).toEqual([]);
    });

    it('forgets old claims when the next turn opens its first block', () => {
        const landed = applyStreamFrame(EMPTY_LIVE_STREAM, { t: 'progress', outputTokens: 1 }, T0);
        const claimed = claimStreamKeys(landed, ['m1:0'])!;
        const nextTurn = applyStreamFrame(claimed, { t: 'block-start', mid: 'm2', idx: 0, kind: 'text' }, T0);
        expect(nextTurn.claimedKeys.size).toBe(0);
    });
});

describe('sweep disarming', () => {
    it('a progress frame during a quiet tool call cancels an armed sweep', () => {
        // The failure this pins: liveness flaps mid-turn, ChatList arms the
        // sweep, the agent is inside a tool call so only progress frames
        // arrive — and 1.5s later the whole accumulated answer is deleted,
        // then re-opened from empty by the next delta. Visible truncation.
        const armed = fold([
            { t: 'block-start', mid: 'm1', idx: 0, kind: 'text' },
            { t: 'block-delta', mid: 'm1', idx: 0, text: 'a long answer' },
            { t: 'turn-end' },
        ])!;
        expect(armed.sweepAt).not.toBeNull();

        const kept = applyStreamFrame(armed, { t: 'progress', outputTokens: 9 }, T0 + 100);
        expect(kept.sweepAt).toBeNull();
        expect(sweepDrafts(kept, T0 + DRAFT_SWEEP_DELAY_MS)).toBe(kept);
    });

    it('a block-end also cancels it', () => {
        const armed = fold([
            { t: 'block-start', mid: 'm1', idx: 0, kind: 'text' },
            { t: 'turn-end' },
        ])!;
        const kept = applyStreamFrame(armed, { t: 'block-end', mid: 'm1', idx: 0 }, T0 + 100);
        expect(kept.sweepAt).toBeNull();
    });
});

describe('sweepDrafts', () => {
    it('drops the session once its armed sweep is due', () => {
        const state = fold([{ t: 'block-start', mid: 'm1', idx: 0, kind: 'text' }, { t: 'turn-end' }])!;
        expect(sweepDrafts(state, T0 + DRAFT_SWEEP_DELAY_MS - 1)).toBe(state);
        expect(sweepDrafts(state, T0 + DRAFT_SWEEP_DELAY_MS)).toBeUndefined();
    });

    it('drops a draft whose turn never ended (CLI killed mid-turn)', () => {
        const state = fold([{ t: 'block-start', mid: 'm1', idx: 0, kind: 'text' }])!;
        expect(sweepDrafts(state, T0 + DRAFT_MAX_AGE_MS)).toBeUndefined();
    });
});

describe('streamKeysOf', () => {
    it('collects only real keys', () => {
        expect(streamKeysOf([{ streamKey: 'a:0' }, {}, { streamKey: '' }, { streamKey: 'b:1' }]))
            .toEqual(['a:0', 'b:1']);
    });
});

describe('orphaned blocks from an SDK retry', () => {
    it('forgets a finished block no persisted message ever claimed', () => {
        // The SDK abandons a message mid-stream on a stall/529/refusal and
        // restarts with a NEW id. The abandoned blocks are never persisted, so
        // nothing claims them — they would otherwise sit next to the retry's
        // real answer for the rest of the turn.
        const abandoned = fold([
            { t: 'block-start', mid: 'm1', idx: 0, kind: 'text' },
            { t: 'block-delta', mid: 'm1', idx: 0, text: 'half an ans' },
            { t: 'block-end', mid: 'm1', idx: 0 },
        ])!;
        expect(abandoned.blocks).toHaveLength(1);

        const later = applyStreamFrame(
            abandoned,
            { t: 'block-delta', mid: 'm2', idx: 0, text: 'the retry' },
            T0 + ORPHAN_BLOCK_MS,
        );

        expect(later.blocks.map((b) => b.key)).toEqual(['m2:0']);
    });

    it('keeps a finished block that is still within the claim window', () => {
        const recent = fold([
            { t: 'block-start', mid: 'm1', idx: 0, kind: 'thinking' },
            { t: 'block-delta', mid: 'm1', idx: 0, text: 'reasoning' },
            { t: 'block-end', mid: 'm1', idx: 0 },
        ])!;
        const next = applyStreamFrame(
            recent,
            { t: 'block-delta', mid: 'm1', idx: 1, text: 'answer' },
            T0 + ORPHAN_BLOCK_MS - 1,
        );
        expect(next.blocks.map((b) => b.key)).toEqual(['m1:0', 'm1:1']);
    });
});
