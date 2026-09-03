import { describe, expect, it } from 'vitest';
import {
    liveStatusDetail,
    sparkFrameAt,
    SPARK_FRAMES,
    SPARK_FRAME_MS,
    vibingVerbAt,
    VERB_ROTATE_MS,
} from './liveStatus';
import { vibingMessages } from '@/utils/vibingMessages';

describe('sparkFrameAt', () => {
    it('walks the glyphs in order and wraps', () => {
        const frames = SPARK_FRAMES.map((_, i) => sparkFrameAt(i * SPARK_FRAME_MS));
        expect(frames).toEqual([...SPARK_FRAMES]);
        expect(sparkFrameAt(SPARK_FRAMES.length * SPARK_FRAME_MS)).toBe(SPARK_FRAMES[0]);
    });

    it('is total: no NaN or negative input produces undefined', () => {
        expect(sparkFrameAt(Number.NaN)).toBeTypeOf('string');
        expect(sparkFrameAt(-5)).toBeTypeOf('string');
    });
});

describe('vibingVerbAt', () => {
    it('holds a verb for the full rotation window', () => {
        const first = vibingVerbAt('s1', 0);
        expect(vibingVerbAt('s1', VERB_ROTATE_MS - 1)).toBe(first);
        // Re-rendering mid-window (the 1s timer ticks four times per window)
        // must not change the word — that flicker is the whole reason this is
        // derived from elapsed time rather than picked randomly.
        expect(vibingVerbAt('s1', 999)).toBe(first);
    });

    it('advances exactly one step per window', () => {
        const at = (ms: number) => vibingMessages.indexOf(vibingVerbAt('s1', ms));
        const zero = at(0);
        expect(at(VERB_ROTATE_MS)).toBe((zero + 1) % vibingMessages.length);
        expect(at(VERB_ROTATE_MS * 2)).toBe((zero + 2) % vibingMessages.length);
    });

    it('gives different sessions different starting verbs', () => {
        const starts = new Set(['a', 'b', 'c', 'd', 'e'].map((id) => vibingVerbAt(id, 0)));
        expect(starts.size).toBeGreaterThan(1);
    });
});

describe('liveStatusDetail', () => {
    it('omits tokens entirely when the CLI reports none (old CLI degradation)', () => {
        expect(liveStatusDetail({}, '12s')).toEqual(['12s']);
        expect(liveStatusDetail({ thinkingTokens: 0, outputTokens: 0 }, '12s')).toEqual(['12s']);
    });

    it('shows thinking tokens while thinking and output tokens once text flows', () => {
        expect(liveStatusDetail({ thinkingTokens: 1200 }, '3s')).toEqual(['3s', '↑ 1.2k tokens']);
        expect(liveStatusDetail({ thinkingTokens: 1200, outputTokens: 40 }, '3s')).toEqual(['3s', '↑ 40 tokens']);
    });
});
