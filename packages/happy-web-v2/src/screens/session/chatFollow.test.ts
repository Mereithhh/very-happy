import { describe, it, expect } from 'vitest';
import {
    nextAwaySnapshot,
    unseenRows,
    formatUnseen,
    isBottomEdgeChange,
    shouldFollowGrowth,
    shouldFollowShrink,
    shouldSmoothJumpToLatest,
    followAfterScroll,
    isUpwardWheel,
    isUpwardTouch,
    isUpwardScrollKey,
    heldTranscript,
    settleWait,
    anchorIndex,
    SCROLL_SETTLE_MS,
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

describe('isBottomEdgeChange', () => {
    const edge = (newestKey: string | null, lastContentLen = 10) => ({ newestKey, lastContentLen });
    it('older history prepended at the top is not a bottom change', () => {
        expect(isBottomEdgeChange(edge('r9'), edge('r9'))).toBe(false);
    });
    it('a new newest row is', () => {
        expect(isBottomEdgeChange(edge('r9'), edge('r10'))).toBe(true);
    });
    it('the newest message growing in place (streaming) is', () => {
        expect(isBottomEdgeChange(edge('r9', 10), edge('r9', 42))).toBe(true);
    });
});

describe('followAfterScroll (B-598)', () => {
    it('未脱离时沿用 80px 跟随带', () => {
        expect(followAfterScroll(false, 0)).toEqual({ atBottom: true, detached: false });
        expect(followAfterScroll(false, 79)).toEqual({ atBottom: true, detached: false });
        expect(followAfterScroll(false, 80)).toEqual({ atBottom: false, detached: false });
    });

    it('脱离后带内不再重新上膛——只有真正到底才回来', () => {
        expect(followAfterScroll(true, 10)).toEqual({ atBottom: false, detached: true });
        expect(followAfterScroll(true, 79)).toEqual({ atBottom: false, detached: true });
        expect(followAfterScroll(true, 2)).toEqual({ atBottom: true, detached: false });
        expect(followAfterScroll(true, 0.5)).toEqual({ atBottom: true, detached: false });
        expect(followAfterScroll(true, 0)).toEqual({ atBottom: true, detached: false });
    });
});

describe('upward intent (B-598)', () => {
    it('滚轮只有向上算', () => {
        expect(isUpwardWheel(-1)).toBe(true);
        expect(isUpwardWheel(0)).toBe(false);
        expect(isUpwardWheel(4)).toBe(false);
    });

    it('触摸：手指下移超过死区 = 内容上滚', () => {
        expect(isUpwardTouch(200, 210)).toBe(true);
        expect(isUpwardTouch(200, 203)).toBe(false);
        expect(isUpwardTouch(200, 150)).toBe(false);
    });

    it('上翻按键', () => {
        for (const key of ['PageUp', 'ArrowUp', 'Home']) expect(isUpwardScrollKey({ key })).toBe(true);
        expect(isUpwardScrollKey({ key: ' ', shiftKey: true })).toBe(true);
        expect(isUpwardScrollKey({ key: 'ArrowUp', metaKey: true })).toBe(true);
        expect(isUpwardScrollKey({ key: ' ' })).toBe(false);
        expect(isUpwardScrollKey({ key: 'PageDown' })).toBe(false);
        expect(isUpwardScrollKey({ key: 'End' })).toBe(false);
        expect(isUpwardScrollKey({ key: 'ArrowUp', ctrlKey: true })).toBe(false);
        expect(isUpwardScrollKey({ key: 'ArrowUp', altKey: true })).toBe(false);
        expect(isUpwardScrollKey({ key: 'Home', metaKey: true })).toBe(false);
    });
});

describe('B-603: hold older history while the transcript moves', () => {
    it('heldTranscript renders from the held message on, older ones wait', () => {
        const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
        expect(heldTranscript(list, null)).toBe(list);
        expect(heldTranscript(list, 'b').map((m) => m.id)).toEqual(['b', 'c']);
        expect(heldTranscript(list, 'a')).toBe(list);
        // the held message is gone (rebuilt history): render everything rather than nothing
        expect(heldTranscript(list, 'zz')).toBe(list);
    });

    it('settleWait: a finger down never settles; otherwise SCROLL_SETTLE_MS after the last motion', () => {
        expect(settleWait(1000, 0, true)).toBe(SCROLL_SETTLE_MS);
        expect(settleWait(1000, 1000, false)).toBe(SCROLL_SETTLE_MS);
        expect(settleWait(1000, 1000 - SCROLL_SETTLE_MS + 30, false)).toBe(30);
        expect(settleWait(1000, 1000 - SCROLL_SETTLE_MS, false)).toBe(0);
    });

    it('anchorIndex: first child reaching below the viewport top, never the rebuildable top row', () => {
        const bottoms = [-300, -200, -100, 0, 100, 200];
        const at = (line: number, min: number) => anchorIndex(bottoms.length, (i) => bottoms[i], line, min);
        expect(at(-150, 1)).toBe(2);
        expect(at(-1000, 1)).toBe(1); // reading the very top: skip row 0
        expect(at(50, 1)).toBe(4);
        expect(at(1000, 1)).toBe(5); // clamp to the last child
        expect(anchorIndex(0, () => 0, 0, 1)).toBe(-1);
    });
});
