import { describe, it, expect } from 'vitest';
import {
    nextAwaySnapshot,
    unseenRows,
    formatUnseen,
    shouldFollowGrowth,
    shouldFollowShrink,
    shouldSmoothJumpToLatest,
} from './chatFollow';

describe('nextAwaySnapshot', () => {
    it('贴底时永远没有快照', () => {
        expect(nextAwaySnapshot(null, true, 'r9')).toBeNull();
        expect(nextAwaySnapshot('r6', true, 'r9')).toBeNull(); // 回底清零
    });

    it('离底那一刻记下最新一行的 key', () => {
        expect(nextAwaySnapshot(null, false, 'r9')).toBe('r9');
    });

    it('持续离底时快照保持不变（增量以离底时刻为界）', () => {
        expect(nextAwaySnapshot('r9', false, 'r14')).toBe('r9');
    });
});

const keys = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `r${from + i}`);

describe('unseenRows', () => {
    it('贴底（无快照）恒为 0', () => {
        expect(unseenRows(null, keys(0, 41))).toBe(0);
    });

    it('离底后新增的 row 数', () => {
        expect(unseenRows('r9', keys(0, 9))).toBe(0);
        expect(unseenRows('r9', keys(0, 12))).toBe(3);
    });

    it('顶部插入的旧历史不算新消息（后台预取，Xu CHEN 实报 99+）', () => {
        // 离底时 r100..r159；预取三页把 r-20..r99 插到前面，底部没有新行
        expect(unseenRows('r159', keys(-20, 159))).toBe(0);
        // 同时底部真的来了 2 行
        expect(unseenRows('r159', keys(-20, 161))).toBe(2);
    });

    it('快照行不在了（重建换 key）不乱报', () => {
        expect(unseenRows('gone', keys(0, 7))).toBe(0);
    });
});

describe('formatUnseen', () => {
    it('0 或负数不显示', () => {
        expect(formatUnseen(0)).toBeNull();
        expect(formatUnseen(-1)).toBeNull();
    });

    it('1..99 原样显示', () => {
        expect(formatUnseen(1)).toBe('1');
        expect(formatUnseen(99)).toBe('99');
    });

    it('超过 99 显示 99+', () => {
        expect(formatUnseen(100)).toBe('99+');
    });
});

describe('shouldFollowGrowth', () => {
    it('贴底且高度增长 → 跟随', () => {
        expect(shouldFollowGrowth(100, 150, true)).toBe(true);
    });

    it('用户上滚回看时绝不跟随（atBottom=false）', () => {
        expect(shouldFollowGrowth(100, 150, false)).toBe(false);
    });

    it('高度不变或收缩不跟随', () => {
        expect(shouldFollowGrowth(150, 150, true)).toBe(false);
        expect(shouldFollowGrowth(150, 100, true)).toBe(false);
    });
});

describe('shouldFollowShrink (B-114 键盘弹起保持贴底)', () => {
    it('follows only when at bottom AND the container got shorter', () => {
        expect(shouldFollowShrink(800, 420, true)).toBe(true);   // keyboard opened
        expect(shouldFollowShrink(420, 800, true)).toBe(false);  // keyboard closed — browser clamps
        expect(shouldFollowShrink(800, 800, true)).toBe(false);  // no change
        expect(shouldFollowShrink(800, 420, false)).toBe(false); // reading history — never yank
    });
});

describe('shouldSmoothJumpToLatest', () => {
    it('smooths a nearby catch-up but jumps immediately across a long transcript', () => {
        expect(shouldSmoothJumpToLatest(600, 500)).toBe(true);
        expect(shouldSmoothJumpToLatest(1000, 500)).toBe(true);
        expect(shouldSmoothJumpToLatest(1001, 500)).toBe(false);
    });

    it('does not request animation for invalid or already-bottom distances', () => {
        expect(shouldSmoothJumpToLatest(0, 500)).toBe(false);
        expect(shouldSmoothJumpToLatest(100, 0)).toBe(false);
    });
});
