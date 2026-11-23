import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexContextOccupancy, readCodexContextUsage, type CodexContextUsage } from '@slopus/happy-wire';
import { normalizeAgentUsage } from '@/api/usageReport';
import { CodexContextTracker } from './codexContextTracker';

const breakdown = (inputTokens: number, totalTokens: number) => ({ totalTokens, inputTokens, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: inputTokens ? totalTokens - inputTokens : 0, reasoningOutputTokens: 0 });
const usage = (type: string, thread: string, input: number, lastTotal: number, total: number, window: number | null = 258_400) => ({ type, thread_id: thread, total: breakdown(total, total), last: breakdown(input, lastTotal), modelContextWindow: window });

describe('codexContextOccupancy', () => {
    it('reads the newest request, not the running total, and Codex’s own window', () => {
        expect(codexContextOccupancy(usage('token_count', 't', 45_000, 45_300, 85_600))).toEqual({ tokens: 45_000, contextWindow: 258_400 });
    });
    it('reads the estimate after a compaction (breakdown all 0, only totalTokens set)', () => {
        expect(codexContextOccupancy({ last: breakdown(0, 14_991), total: breakdown(135_000, 135_900), modelContextWindow: 258_400 })).toEqual({ tokens: 14_991, contextWindow: 258_400 });
    });
    it('reports nothing rather than 0 for empty, missing or malformed usage', () => {
        for (const raw of [null, {}, { last: null }, { last: breakdown(0, 0) }, { last: { inputTokens: 'x' } }, { total: breakdown(5, 5) }]) expect(codexContextOccupancy(raw)).toBeNull();
        expect(codexContextOccupancy(usage('token_count', 't', 10, 10, 10, null))).toEqual({ tokens: 10, contextWindow: null });
    });
    it('leaves the usage report cumulative', () => {
        expect(normalizeAgentUsage(usage('token_count', 't', 45_000, 45_300, 85_600))?.total).toBe(85_600);
    });
});

describe('CodexContextTracker', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });
    const make = () => {
        const writes: Array<CodexContextUsage | null> = [];
        return { writes, tracker: new CodexContextTracker((u) => writes.push(u), 2_000) };
    };

    it('writes the first figure at once and the newest of a burst afterwards', () => {
        const { writes, tracker } = make();
        tracker.onUsage(usage('token_count', 'main', 40_000, 40_300, 40_300));
        tracker.onUsage(usage('token_count', 'main', 50_000, 50_300, 90_600));
        tracker.onUsage(usage('token_count', 'main', 0, 14_991, 90_600));
        expect(writes.map((w) => w?.tokens)).toEqual([40_000]);
        vi.advanceTimersByTime(2_000);
        expect(writes.map((w) => w?.tokens)).toEqual([40_000, 14_991]);
    });

    it('files a child thread under itself and never moves the session figure', () => {
        const { writes, tracker } = make();
        tracker.onUsage(usage('token_count', 'main', 40_000, 40_300, 40_300));
        tracker.onUsage(usage('child_token_count', 'kid', 24_000, 24_400, 198_000));
        vi.advanceTimersByTime(2_000);
        expect(writes.at(-1)).toMatchObject({ threadId: 'main', tokens: 40_000, children: [{ threadId: 'kid', tokens: 24_000, contextWindow: 258_400 }] });
        expect(readCodexContextUsage(writes.at(-1))).toEqual(writes.at(-1));
    });

    it('keeps the newest 16 children and drops them with their thread', () => {
        const { writes, tracker } = make();
        tracker.onUsage(usage('token_count', 'main', 40_000, 40_300, 40_300));
        for (let i = 0; i < 20; i++) tracker.onUsage(usage('child_token_count', `kid${i}`, 1_000 + i, 2_000, 2_000));
        vi.advanceTimersByTime(2_000);
        expect(writes.at(-1)?.children).toHaveLength(16);
        expect(writes.at(-1)?.children?.[0].threadId).toBe('kid19');
        tracker.onUsage(usage('token_count', 'other', 9_000, 9_100, 9_100));
        vi.advanceTimersByTime(2_000);
        expect(writes.at(-1)).toMatchObject({ threadId: 'other', tokens: 9_000 });
        expect(writes.at(-1)?.children).toBeUndefined();
    });

    it('a rewind makes the figure unknown and /clear removes it, without a pending write undoing either', () => {
        const { writes, tracker } = make();
        tracker.onUsage(usage('token_count', 'main', 40_000, 40_300, 40_300));
        tracker.onUsage(usage('token_count', 'main', 50_000, 50_300, 90_600));
        tracker.invalidate();
        vi.advanceTimersByTime(5_000);
        expect(writes.at(-1)).toMatchObject({ threadId: 'main', tokens: null });
        tracker.reset();
        vi.advanceTimersByTime(5_000);
        expect(writes.at(-1)).toBeNull();
    });

    it('a resumed wrapper keeps the sub-agent figures of the same thread, not another one’s', () => {
        const left = { threadId: 'main', tokens: 1, updatedAt: 1, children: [{ threadId: 'kid', tokens: 24_000, contextWindow: 258_400 }] };
        for (const [thread, kept] of [['main', 1], ['other', undefined]] as const) {
            const writes: Array<CodexContextUsage | null> = [];
            new CodexContextTracker((u) => writes.push(u), 2_000, Date.now, () => left).onUsage(usage('token_count', thread, 0, 14_991, 135_900));
            expect(writes[0]).toMatchObject({ threadId: thread, tokens: 14_991 });
            expect(writes[0]?.children?.length).toBe(kept);
        }
    });

    it('dispose writes what is still pending', () => {
        const { writes, tracker } = make();
        tracker.onUsage(usage('token_count', 'main', 40_000, 40_300, 40_300));
        tracker.onUsage(usage('token_count', 'main', 50_000, 50_300, 90_600));
        tracker.dispose();
        expect(writes.at(-1)?.tokens).toBe(50_000);
    });
});
