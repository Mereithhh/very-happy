import { describe, expect, it } from 'vitest';
import {
    PROGRESS_MAX_CHARS,
    SELF_REPORT_FRESH_MS,
    SELF_REPORT_MIN_INTERVAL_MS,
    createSelfReportState,
    isSelfReportFresh,
    normalizeAttention,
    normalizeProgress,
    shouldAcceptSelfReport,
} from './boardReport';

describe('自报节流', () => {
    it('首次总是接受', () => {
        expect(shouldAcceptSelfReport(createSelfReportState(), 1_000)).toBe(true);
    });

    it('间隔不足时拒绝，够了才接受', () => {
        const state = { lastAcceptedAt: 100_000 };
        expect(shouldAcceptSelfReport(state, 100_000 + SELF_REPORT_MIN_INTERVAL_MS - 1)).toBe(false);
        expect(shouldAcceptSelfReport(state, 100_000 + SELF_REPORT_MIN_INTERVAL_MS)).toBe(true);
    });

    it('被节流掉的调用不该推进水位——否则疯狂刷就能永久压制 analyzer', () => {
        // 这条是行为契约的断言：调用方只在 accept 时才写 lastAcceptedAt。
        const state = { lastAcceptedAt: 100_000 };
        const now = 100_001;
        if (shouldAcceptSelfReport(state, now)) state.lastAcceptedAt = now;
        expect(state.lastAcceptedAt).toBe(100_000);
    });
});

describe('自报水位（boardAnalyzer 据此跳过花钱的分析）', () => {
    it('从未自报 → 不新鲜', () => {
        expect(isSelfReportFresh(createSelfReportState(), 999_999)).toBe(false);
    });

    it('新鲜期内为真，过期为假', () => {
        const state = { lastAcceptedAt: 1_000_000 };
        expect(isSelfReportFresh(state, 1_000_000)).toBe(true);
        expect(isSelfReportFresh(state, 1_000_000 + SELF_REPORT_FRESH_MS - 1)).toBe(true);
        expect(isSelfReportFresh(state, 1_000_000 + SELF_REPORT_FRESH_MS)).toBe(false);
    });

    it('时钟回跳不该把未来的水位当成新鲜（否则 analyzer 会被永久压制）', () => {
        const state = { lastAcceptedAt: 5_000_000 };
        expect(isSelfReportFresh(state, 1_000_000)).toBe(false);
    });

    it('新鲜期严格长于 analyzer 的最小间隔——自报要能压掉数轮分析', () => {
        expect(SELF_REPORT_FRESH_MS).toBeGreaterThan(5 * 60 * 1000);
    });
});

describe('入参规范化', () => {
    it('attention 只认三个值，其余当 none', () => {
        expect(normalizeAttention('blocked')).toBe('blocked');
        expect(normalizeAttention('review')).toBe('review');
        expect(normalizeAttention('none')).toBe('none');
        for (const bad of ['BLOCKED', 'urgent', '', null, undefined, 42, {}]) {
            expect(normalizeAttention(bad), String(bad)).toBe('none');
        }
    });

    it('progress 压成单行、去空白、截断', () => {
        expect(normalizeProgress('  跑\n\n测试  中 ')).toBe('跑 测试 中');
        expect(normalizeProgress('x'.repeat(PROGRESS_MAX_CHARS + 50))?.length).toBe(PROGRESS_MAX_CHARS);
    });

    it('空/非字符串 progress 返回 null（不写 metadata）', () => {
        expect(normalizeProgress('')).toBeNull();
        expect(normalizeProgress('   \n ')).toBeNull();
        expect(normalizeProgress(null)).toBeNull();
        expect(normalizeProgress(7)).toBeNull();
    });
});
