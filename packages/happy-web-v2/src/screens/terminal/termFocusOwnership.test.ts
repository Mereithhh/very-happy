/**
 * 焦点所有权不变量 + 看门狗的回归测试。
 *
 * 事故锚点（2026-08-14，CDP 实测）：`⌘K` 命令面板 → Esc、`⌘R` 重命名弹窗 → Esc
 * 之后 `document.activeElement === BODY`，终端中英文全哑（0 字节进 PTY），而
 * 视觉上只有 xterm 光标从实心变空心 —— 用户完全看不出焦点已经丢了。根因是
 * "关浮层后归还焦点"是三处各写一遍的偶然行为，新弹窗一律漏写。这里锁住的是
 * 替代方案的三条纪律：无主才归还、有浮层不抢、合成期不动。
 *
 * node 环境无 DOM：判定是纯函数，DOM 探测是鸭子类型（假 element / 假 root）。
 */
import { describe, it, expect, vi } from 'vitest';
import {
    classifyFocusHolder,
    createFocusOwnershipWatchdog,
    hasNonCollapsedSelection,
    hasOpenOverlay,
    isOpenTerminalRoute,
    OVERLAY_SELECTOR,
    shouldRestoreTerminalFocus,
    type FocusOwnershipInput,
} from './termFocusOwnership';

/** 病态基线：正是实测里"焦点掉到 body"的那一刻 —— 应当归还。 */
const ORPHANED: FocusOwnershipInput = {
    onTerminalRoute: true,
    hasOverlay: false,
    holder: 'nobody',
    composing: false,
    documentHidden: false,
    windowFocused: true,
    coarsePointer: false,
    hasTextSelection: false,
};

const I = (over: Partial<FocusOwnershipInput> = {}): FocusOwnershipInput => ({
    ...ORPHANED,
    ...over,
});

describe('shouldRestoreTerminalFocus', () => {
    it('归还：终端页 + 无浮层 + 焦点无主（事故态本身）', () => {
        expect(shouldRestoreTerminalFocus(ORPHANED)).toBe(true);
    });

    it('不归还：不在打开的终端页（别的屏幕不是我们的事）', () => {
        expect(shouldRestoreTerminalFocus(I({ onTerminalRoute: false }))).toBe(false);
    });

    it('不归还：有浮层打开（弹窗输入框才是焦点的主人）', () => {
        expect(shouldRestoreTerminalFocus(I({ hasOverlay: true }))).toBe(false);
    });

    it('不归还：焦点已经在终端（幂等 —— 看门狗静止时零副作用）', () => {
        expect(shouldRestoreTerminalFocus(I({ holder: 'terminal' }))).toBe(false);
    });

    it('不归还：焦点有别的主人（笔记 dock / 文件过滤框 / header 按钮）', () => {
        expect(shouldRestoreTerminalFocus(I({ holder: 'other' }))).toBe(false);
    });

    it('不归还：正在 IME 合成（动焦点会吞掉在途拼音）', () => {
        expect(shouldRestoreTerminalFocus(I({ composing: true }))).toBe(false);
    });

    it('不归还：标签页在后台', () => {
        expect(shouldRestoreTerminalFocus(I({ documentHidden: true }))).toBe(false);
    });

    it('不归还：窗口没有系统焦点（别和别的应用抢）', () => {
        expect(shouldRestoreTerminalFocus(I({ windowFocused: false }))).toBe(false);
    });

    it('不归还：粗指针设备（强抢焦点会顶起软键盘）', () => {
        expect(shouldRestoreTerminalFocus(I({ coarsePointer: true }))).toBe(false);
    });

    it('不归还：页面上有拖选中的文本（用户在准备复制，抢焦点会清掉选区）', () => {
        expect(shouldRestoreTerminalFocus(I({ hasTextSelection: true }))).toBe(false);
    });

    it('全表：只有全部条件同时成立才归还', () => {
        // 9 个否决条件逐个单独打开，其余保持病态基线 —— 每一个都必须否决。
        const vetoes: Array<Partial<FocusOwnershipInput>> = [
            { onTerminalRoute: false },
            { hasOverlay: true },
            { holder: 'terminal' },
            { holder: 'other' },
            { composing: true },
            { documentHidden: true },
            { windowFocused: false },
            { coarsePointer: true },
            { hasTextSelection: true },
        ];
        for (const v of vetoes) expect(shouldRestoreTerminalFocus(I(v))).toBe(false);
        // 并且否决条件全部撤掉时确实归还（避免"永远 false"的假绿）
        expect(shouldRestoreTerminalFocus(I())).toBe(true);
    });
});

describe('isOpenTerminalRoute', () => {
    it('打开的终端页命中（含尾斜杠）', () => {
        expect(isOpenTerminalRoute('/terminal/machine-1')).toBe(true);
        expect(isOpenTerminalRoute('/terminal/machine-1/')).toBe(true);
    });

    it('终端选择器页不算（那里没有终端）', () => {
        expect(isOpenTerminalRoute('/terminal')).toBe(false);
        expect(isOpenTerminalRoute('/terminal/')).toBe(false);
    });

    it('其他路由不命中', () => {
        expect(isOpenTerminalRoute('/')).toBe(false);
        expect(isOpenTerminalRoute('/session/abc')).toBe(false);
        expect(isOpenTerminalRoute('/settings/snippets')).toBe(false);
        expect(isOpenTerminalRoute('/terminal/machine-1/extra')).toBe(false);
    });
});

describe('hasOpenOverlay', () => {
    const root = (hit: boolean) => ({
        querySelector: vi.fn((s: string) => (s === OVERLAY_SELECTOR && hit ? {} : null)),
    });

    it('判据里同时包含 role=dialog 与 Radix popper 容器（不猜 z-index）', () => {
        // 依据见模块注释：本仓每个浮层卡片都写了 role="dialog"，Radix 的下拉/
        // 右键菜单一律套 [data-radix-popper-content-wrapper] 且无 forceMount。
        expect(OVERLAY_SELECTOR).toContain('[role="dialog"]');
        expect(OVERLAY_SELECTOR).toContain('[data-radix-popper-content-wrapper]');
    });

    it('有匹配 ⇒ true，无匹配 ⇒ false', () => {
        expect(hasOpenOverlay(root(true))).toBe(true);
        expect(hasOpenOverlay(root(false))).toBe(false);
    });

    it('没有 root（SSR / 卸载中）⇒ false', () => {
        expect(hasOpenOverlay(null)).toBe(false);
        expect(hasOpenOverlay(undefined)).toBe(false);
    });

    it('querySelector 抛异常时宁可不动作', () => {
        expect(hasOpenOverlay({ querySelector: () => { throw new Error('unsupported'); } })).toBe(false);
    });
});

describe('hasNonCollapsedSelection', () => {
    it('没有选区对象 / 折叠的插入点 ⇒ false', () => {
        expect(hasNonCollapsedSelection(null)).toBe(false);
        expect(hasNonCollapsedSelection(undefined)).toBe(false);
        expect(hasNonCollapsedSelection({ isCollapsed: true, rangeCount: 1 })).toBe(false);
        expect(hasNonCollapsedSelection({ isCollapsed: false, rangeCount: 0 })).toBe(false);
    });

    it('真的选中了东西 ⇒ true', () => {
        expect(hasNonCollapsedSelection({ isCollapsed: false, rangeCount: 1 })).toBe(true);
    });

    it('isCollapsed 缺失的实现退化成看文本长度', () => {
        expect(hasNonCollapsedSelection({ toString: () => '' })).toBe(false);
        expect(hasNonCollapsedSelection({ toString: () => 'picked' })).toBe(true);
    });
});

describe('classifyFocusHolder', () => {
    const ta = { tagName: 'TEXTAREA', classList: { contains: (n: string) => n === 'xterm-helper-textarea' } };

    it('null / body / html 都算「没人」（实测的失焦态）', () => {
        expect(classifyFocusHolder(null, ta)).toBe('nobody');
        expect(classifyFocusHolder(undefined, ta)).toBe('nobody');
        expect(classifyFocusHolder({ tagName: 'BODY' }, ta)).toBe('nobody');
        expect(classifyFocusHolder({ tagName: 'HTML' }, ta)).toBe('nobody');
        expect(classifyFocusHolder({ tagName: 'body' }, ta)).toBe('nobody'); // 大小写无关
    });

    it('helper textarea 本体 = terminal', () => {
        expect(classifyFocusHolder(ta, ta)).toBe('terminal');
    });

    it('按 class 兜底：renderer 重建了 textarea（引用换了）也算 terminal', () => {
        const rebuilt = { tagName: 'TEXTAREA', classList: { contains: (n: string) => n === 'xterm-helper-textarea' } };
        expect(classifyFocusHolder(rebuilt, ta)).toBe('terminal');
    });

    it('别的元素 = other（有主，绝不抢）', () => {
        const input = { tagName: 'INPUT', classList: { contains: () => false } };
        expect(classifyFocusHolder(input, ta)).toBe('other');
        expect(classifyFocusHolder({ tagName: 'BUTTON' }, ta)).toBe('other');
    });

    it('终端还没挂载（textarea 为 null）时不会把随便什么元素当成终端', () => {
        expect(classifyFocusHolder({ tagName: 'INPUT', classList: { contains: () => false } }, null)).toBe('other');
        expect(classifyFocusHolder(null, null)).toBe('nobody');
    });
});

describe('createFocusOwnershipWatchdog', () => {
    const mk = (snap: FocusOwnershipInput) => {
        const state = { snap };
        const restore = vi.fn(() => { state.snap = { ...state.snap, holder: 'terminal' }; });
        let t = 0;
        const timers: Array<{ id: number; at: number; fn: () => void }> = [];
        let nextId = 1;
        const wd = createFocusOwnershipWatchdog({
            read: () => state.snap,
            restore,
            settleMs: 100,
            now: () => t,
            schedule: (fn, ms) => {
                const id = nextId++;
                timers.push({ id, at: t + ms, fn });
                return id as unknown as ReturnType<typeof setTimeout>;
            },
            cancel: (id) => {
                const i = timers.findIndex((x) => x.id === (id as unknown as number));
                if (i >= 0) timers.splice(i, 1);
            },
        });
        const advance = (ms: number) => {
            t += ms;
            for (const timer of timers.filter((x) => x.at <= t)) {
                timers.splice(timers.indexOf(timer), 1);
                timer.fn();
            }
        };
        return { wd, restore, state, advance, pending: () => timers.length, now: () => t };
    };

    it('check() 在事故态归还焦点，并且第二次调用不再动作（幂等）', () => {
        const { wd, restore } = mk(ORPHANED);
        expect(wd.check()).toBe(true);
        expect(restore).toHaveBeenCalledTimes(1);
        // restore 已把 holder 变成 terminal → 不变量不再被违背
        expect(wd.check()).toBe(false);
        expect(restore).toHaveBeenCalledTimes(1);
        expect(wd.counters.restores).toBe(1);
        expect(wd.counters.checks).toBe(2);
    });

    it('有浮层时绝不动作（不抢弹窗输入框的焦点），并计入诊断计数器', () => {
        const { wd, restore } = mk({ ...ORPHANED, hasOverlay: true });
        expect(wd.check()).toBe(false);
        expect(restore).not.toHaveBeenCalled();
        expect(wd.counters.skippedOverlay).toBe(1);
    });

    it('合成期绝不动作，并计入诊断计数器', () => {
        const { wd, restore } = mk({ ...ORPHANED, composing: true });
        expect(wd.check()).toBe(false);
        expect(restore).not.toHaveBeenCalled();
        expect(wd.counters.skippedComposing).toBe(1);
    });

    it('lastRestoreAt 记录归还时刻（诊断钩子读它）', () => {
        const { wd, advance } = mk(ORPHANED);
        expect(wd.lastRestoreAt).toBe(0);
        advance(500);
        wd.check();
        expect(wd.lastRestoreAt).toBe(500);
    });

    it('noteFocusChange 延后探测，并把 focusout+focusin 合并成一次', () => {
        const { wd, restore, advance, pending } = mk(ORPHANED);
        wd.noteFocusChange(); // focusout
        wd.noteFocusChange(); // 紧随的 focusin
        expect(pending()).toBe(1); // 合并，不是两个待处理定时器
        expect(restore).not.toHaveBeenCalled(); // 还没落定
        advance(100);
        expect(restore).toHaveBeenCalledTimes(1);
    });

    it('焦点转移到别的真实元素时，延后探测不会抢回来', () => {
        const { wd, restore, state, advance } = mk(ORPHANED);
        wd.noteFocusChange();
        state.snap = { ...state.snap, holder: 'other' }; // 焦点落到弹窗输入框
        advance(100);
        expect(restore).not.toHaveBeenCalled();
    });

    it('dispose 之后不再求值、不再归还（挂起的探测也被取消）', () => {
        const { wd, restore, advance } = mk(ORPHANED);
        wd.noteFocusChange();
        wd.dispose();
        advance(1000);
        expect(restore).not.toHaveBeenCalled();
        expect(wd.check()).toBe(false);
        wd.noteFocusChange();
        advance(1000);
        expect(restore).not.toHaveBeenCalled();
    });
});
