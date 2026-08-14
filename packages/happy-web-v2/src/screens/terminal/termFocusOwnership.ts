/**
 * 终端键盘焦点所有权不变量 + 看门狗（round 3, 2026-08-14）
 *
 * ── 这个模块存在的原因（CDP 实证，不是推理）─────────────────────────────
 * 中文输入法第三次失效里，**持续性**的那一半（中英文全哑）根本不是 IME 问题：
 * `⌘K` 命令面板 → Esc、`⌘R` 重命名弹窗 → Esc 之后
 * `document.activeElement === BODY`，composition 事件 0 个、进 PTY 0 字节。
 * 视觉上几乎看不出（xterm 光标只是从实心变空心），所以用户以为焦点还在终端，
 * 只觉得"终端不接受输入了"。点一下终端即恢复。
 *
 * 根因是**结构性**的：关闭浮层后把焦点还给终端，是三处各写一遍的偶然行为
 * （`viewShortcuts.restoreFocusAfterCancel`、Radix 的 `onCloseAutoFocus`、
 * `TermPresetsMenu` 的 onCancel），而 `CommandPalette` / `RenameModal` /
 * `NewSessionModal` / 任何非 ⌘W 路径打开的 `ModalProvider` 弹窗都没写。
 * 逐个弹窗打补丁只会再漏下一个 —— 所以这里改成一条**不变量 + 看门狗**：
 *
 *   在终端页 ∧ 没有浮层 ∧ 焦点在"没人"手里（body / null）
 *   ⇒ 焦点必须属于终端，看门狗把它还回去。
 *
 * ── 三条硬纪律 ────────────────────────────────────────────────────────
 * 1. **绝不 blur。** 用 blur 当"治疗手段"正是同一次事故里"中文哑英文正常"的
 *    直接病因（`refocus()` 的 `ta.blur()` 会吞掉在途合成文本）。本模块只会
 *    调用调用方给的 `restore()`，而 `restore()` 只许 focus。
 * 2. **绝不抢焦点。** `holder !== 'nobody'` 一律不动作 —— 弹窗里的输入框、
 *    笔记 dock、文件浏览器的过滤框、header 按钮都是"有主"的焦点，抢过来会
 *    造成比原 bug 更糟的手感。只有真正无主（body/null）才归还。
 * 3. **合成期不动焦点。** 正在 IME 合成时任何焦点变化都可能静默丢弃在途拼音，
 *    一律跳过（`composing` 由 imeStuckGuard 维护，见那个文件的注释：那个布尔
 *    **只**用于"要不要动焦点"，绝不参与"是否发送文本"的判断）。
 *
 * 判定是纯函数（`shouldRestoreTerminalFocus`），全表单测；DOM 探测
 * （`hasOpenOverlay` / `classifyFocusHolder`）是鸭子类型的薄壳，可在 node 下测。
 */

/** 谁拿着键盘焦点。'nobody' = body / null / documentElement —— 实测的病态。 */
export type FocusHolder = 'terminal' | 'other' | 'nobody';

export interface FocusOwnershipInput {
    /** 当前路由是一个**打开的终端**（`/terminal/:machineId`），不是选择器页。 */
    onTerminalRoute: boolean;
    /** 有浮层（弹窗 / 命令面板 / Radix 菜单 / 面板）打开 —— 焦点归它。 */
    hasOverlay: boolean;
    /** 焦点当前的主人。 */
    holder: FocusHolder;
    /** 正在 IME 合成 —— 动焦点会吞掉在途文本。 */
    composing: boolean;
    /** 标签页在后台：不参与焦点竞争（回到前台会再判一次）。 */
    documentHidden: boolean;
    /** 窗口（而非只是文档）确实持有系统焦点。 */
    windowFocused: boolean;
    /** 粗指针设备：强抢焦点会顶起软键盘，移动端永不自动 focus。 */
    coarsePointer: boolean;
    /**
     * 页面上存在非折叠的文本选区。用户在侧栏/消息里拖选文字后 activeElement 也是
     * body —— 那不是"焦点丢了"，那是"我正在选东西准备复制"。抢焦点可能清掉选区，
     * 所以这也是一条否决条件（三个已确诊触发路径 ⌘K/⌘R/Esc 都不会留下选区）。
     */
    hasTextSelection: boolean;
}

/**
 * 不变量判定：是否应当把焦点还给终端。
 *
 * 顺序无关（全是 AND），写成早退是为了可读 + 每条都能单独单测。
 */
export function shouldRestoreTerminalFocus(i: FocusOwnershipInput): boolean {
    if (!i.onTerminalRoute) return false;
    if (i.coarsePointer) return false; // 纪律：移动端永不强开软键盘
    if (i.hasOverlay) return false; // 纪律 2：浮层有自己的焦点主
    if (i.holder !== 'nobody') return false; // 纪律 2：有主不抢
    if (i.composing) return false; // 纪律 3：合成期不动焦点
    if (i.hasTextSelection) return false; // 拖选中的用户不是失焦的用户
    if (i.documentHidden) return false;
    if (!i.windowFocused) return false;
    return true;
}

/** 页面上是否有非折叠选区（鸭子类型，无 DOM 依赖）。 */
export function hasNonCollapsedSelection(
    sel: { isCollapsed?: boolean; rangeCount?: number; toString?(): string } | null | undefined,
): boolean {
    if (!sel) return false;
    if (sel.isCollapsed === true) return false;
    if (typeof sel.rangeCount === 'number' && sel.rangeCount === 0) return false;
    // isCollapsed 缺失的实现（老 Safari）退化成看文本长度。
    if (sel.isCollapsed === undefined) return (sel.toString?.().length ?? 0) > 0;
    return true;
}

/**
 * 一个**打开的**终端的路由。与 `closeGuard.closeViewTarget` 同一套裸
 * pathname 约定（basename 在生产是 `/`；两处一致比两处各自聪明更重要）。
 * `/terminal`（选择器）没有终端，返回 false。
 */
export function isOpenTerminalRoute(pathname: string): boolean {
    return /^\/terminal\/[^/]+\/?$/.test(pathname);
}

/**
 * 「有浮层打开」的判据 —— **不猜 z-index**，用两个有代码依据的标记：
 *
 *  1. `[role="dialog"]`：本仓**每一个**浮层表面都在自己的卡片上写了这个
 *     （grep 实证，2026-08-14）：`modal/ModalProvider.tsx` 的 ModalCard、
 *     `screens/command/CommandPalette.tsx` 的 `.cp-panel`、
 *     `screens/sessions/RenameModal.tsx`、`NewSessionModal.tsx` 的 `.ns-card`、
 *     `screens/terminal/TmuxHelpModal.tsx` 的 `.tmux-card`、
 *     `screens/board/TaskBoardScreen.tsx` 的 `.bd-modal`、
 *     `screens/clipboard/ClipboardHistoryPanel.tsx` 的 `.ch-panel`、
 *     `screens/notifications/NotificationBell.tsx` 的 `.nc-panel`。
 *     它们全部**只在打开时挂载**，所以"存在 ⇒ 打开"。
 *  2. `[data-radix-popper-content-wrapper]`：Radix 的 Popper 给每个下拉/右键
 *     菜单内容套的 portal 容器（`node_modules/@radix-ui/react-popper` 实证），
 *     本仓所有 `DropdownMenu`/`ContextMenu`（`ui/Menu.tsx`、`TermPresetsMenu`、
 *     `session/ModeMenu`、`session/PresetsMenu`）都走它，且**没有任何一处用
 *     `forceMount`**，所以同样"存在 ⇒ 打开"。
 *     `[role="menu"][data-state="open"]` 作为冗余belt（万一将来有人 forceMount
 *     或换掉 Popper）。
 *
 * 注意：笔记 dock / 文件浏览器 split 都是**挤压式面板**不是浮层，故意不算浮层
 * —— 它们在的时候终端仍然可以合法持有焦点；而它们里面的输入框有焦点时
 * `holder === 'other'` 已经挡住了看门狗。
 */
export const OVERLAY_SELECTOR =
    '[role="dialog"],[data-radix-popper-content-wrapper],[role="menu"][data-state="open"]';

export function hasOpenOverlay(root: { querySelector(s: string): unknown } | null | undefined): boolean {
    if (!root) return false;
    try {
        return root.querySelector(OVERLAY_SELECTOR) != null;
    } catch {
        return false; // 选择器在古董浏览器上不被支持时，宁可不动作
    }
}

interface ElementLike {
    tagName?: string;
    classList?: { contains(name: string): boolean };
}

/**
 * 焦点主人分类（鸭子类型，无 DOM 依赖 / 无 instanceof，可在 node 下测）。
 * `body` / `html` / null 都算「没人」—— 这三种正是实测的失焦态。
 */
export function classifyFocusHolder(
    active: unknown,
    terminalTextarea: unknown,
): FocusHolder {
    if (active == null) return 'nobody';
    if (terminalTextarea != null && active === terminalTextarea) return 'terminal';
    const el = active as ElementLike;
    // 终端的 helper textarea 可能被重建（renderer 重挂载），按 class 兜一层。
    if (el.classList?.contains?.('xterm-helper-textarea')) return 'terminal';
    const tag = el.tagName?.toUpperCase?.();
    if (tag === 'BODY' || tag === 'HTML') return 'nobody';
    return 'other';
}

export interface FocusWatchdogCounters {
    /** 不变量求值次数（含所有触发源）。 */
    checks: number;
    /** 实际归还焦点的次数。 */
    restores: number;
    /** 因为"有浮层"而放弃的次数（诊断用：能区分开抢焦点 vs 没触发）。 */
    skippedOverlay: number;
    /** 因为"合成期"而放弃的次数。 */
    skippedComposing: number;
}

export interface FocusOwnershipWatchdog {
    /** 立即求值一次不变量；违背则归还焦点。返回是否归还了。 */
    check(): boolean;
    /** 焦点动了（focusin/focusout/visibilitychange/window focus）：等落定后再判。 */
    noteFocusChange(): void;
    readonly counters: FocusWatchdogCounters;
    /** 最近一次归还焦点的时间戳（0 = 从未）。 */
    readonly lastRestoreAt: number;
    dispose(): void;
}

type TimerId = ReturnType<typeof setTimeout>;

/**
 * 看门狗核心（定时逻辑纯粹、依赖注入，可单测）。
 *
 * 幂等性由两层保证：① 不变量只在 `holder === 'nobody'` 时为真，归还成功后
 * 下一次求值就是 'terminal' → 不再动作；② 调用方给的 `restore()` 本身也要
 * 幂等（见 WebTerminalScreen 的 `refocusTerminal`）。
 */
export function createFocusOwnershipWatchdog(opts: {
    read: () => FocusOwnershipInput;
    /** 只许 focus，绝不 blur。 */
    restore: () => void;
    /** focusin/focusout 之后等多久再探（焦点转移是两步：先 out 后 in）。 */
    settleMs?: number;
    now?: () => number;
    schedule?: (fn: () => void, ms: number) => TimerId;
    cancel?: (id: TimerId) => void;
}): FocusOwnershipWatchdog {
    const settleMs = opts.settleMs ?? 120;
    const now = opts.now ?? (() => Date.now());
    const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    const cancel = opts.cancel ?? ((id) => clearTimeout(id));
    const counters: FocusWatchdogCounters = {
        checks: 0,
        restores: 0,
        skippedOverlay: 0,
        skippedComposing: 0,
    };
    let lastRestoreAt = 0;
    let settleTimer: TimerId | null = null;
    let disposed = false;

    const check = (): boolean => {
        if (disposed) return false;
        counters.checks++;
        const snap = opts.read();
        if (snap.hasOverlay) counters.skippedOverlay++;
        else if (snap.composing) counters.skippedComposing++;
        if (!shouldRestoreTerminalFocus(snap)) return false;
        opts.restore();
        counters.restores++;
        lastRestoreAt = now();
        return true;
    };

    return {
        check,
        noteFocusChange() {
            if (disposed) return;
            // 合并成一次延后探测：一次焦点转移会连发 focusout+focusin。
            if (settleTimer != null) cancel(settleTimer);
            settleTimer = schedule(() => {
                settleTimer = null;
                check();
            }, settleMs);
        },
        counters,
        get lastRestoreAt() {
            return lastRestoreAt;
        },
        dispose() {
            disposed = true;
            if (settleTimer != null) cancel(settleTimer);
            settleTimer = null;
        },
    };
}

/**
 * 把看门狗接到真实事件源上（薄壳，无判定逻辑）：
 *  - `focusin`/`focusout`（document，冒泡）→ 落定后探测；
 *  - `visibilitychange` / window `focus` → 回到前台/窗口也要探测；
 *  - 低频兜底轮询（默认 1s）→ 覆盖"谁都没发事件"的路径（Radix FocusScope 在
 *    unmount 后把焦点丢给 body 的时序在不同浏览器上并不统一）。
 *    轮询只在不变量为真时才动作，所以静止状态是零副作用的。
 */
export function installFocusOwnershipWatchdog(opts: {
    read: () => FocusOwnershipInput;
    restore: () => void;
    settleMs?: number;
    pollMs?: number;
}): FocusOwnershipWatchdog {
    const wd = createFocusOwnershipWatchdog(opts);
    const onFocusChange = () => wd.noteFocusChange();
    document.addEventListener('focusin', onFocusChange);
    document.addEventListener('focusout', onFocusChange);
    document.addEventListener('visibilitychange', onFocusChange);
    window.addEventListener('focus', onFocusChange);
    const poll = setInterval(() => wd.check(), opts.pollMs ?? 1000);
    return {
        check: () => wd.check(),
        noteFocusChange: () => wd.noteFocusChange(),
        counters: wd.counters,
        get lastRestoreAt() {
            return wd.lastRestoreAt;
        },
        dispose() {
            clearInterval(poll);
            document.removeEventListener('focusin', onFocusChange);
            document.removeEventListener('focusout', onFocusChange);
            document.removeEventListener('visibilitychange', onFocusChange);
            window.removeEventListener('focus', onFocusChange);
            wd.dispose();
        },
    };
}
