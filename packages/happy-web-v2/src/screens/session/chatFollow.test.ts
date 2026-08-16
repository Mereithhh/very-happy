import { describe, it, expect } from 'vitest';
import { nextAwaySnapshot, unseenRows, formatUnseen, shouldFollowGrowth, shouldFollowShrink } from './chatFollow';

describe('nextAwaySnapshot', () => {
    it('贴底时永远没有快照', () => {
        expect(nextAwaySnapshot(null, true, 10)).toBeNull();
        expect(nextAwaySnapshot(7, true, 10)).toBeNull(); // 回底清零
    });

    it('离底那一刻记下当前 row 数', () => {
        expect(nextAwaySnapshot(null, false, 10)).toBe(10);
    });

    it('持续离底时快照保持不变（增量以离底时刻为基准）', () => {
        expect(nextAwaySnapshot(10, false, 15)).toBe(10);
    });
});

describe('unseenRows', () => {
    it('贴底（无快照）恒为 0', () => {
        expect(unseenRows(null, 42)).toBe(0);
    });

    it('离底后新增的 row 数', () => {
        expect(unseenRows(10, 10)).toBe(0);
        expect(unseenRows(10, 13)).toBe(3);
    });

    it('row 数收缩（消息被替换/重建）不出负数', () => {
        expect(unseenRows(10, 8)).toBe(0);
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
