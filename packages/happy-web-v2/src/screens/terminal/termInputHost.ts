/**
 * termInputHost —— 自有输入元素的**宿主**（spec §设计 A/B/C 的接线层，Step 1/2）
 *
 * spec: `specs/2026-08-terminal-input-ownership.md`
 *
 * Step 2（移动端接同一条路径）在这里新增的，全部是**呈现与边界**，路由表与模型
 * 一个字没动（spec §F：统一核心，分叉只在字段策略与呈现）：
 *   - `pickFieldPolicy`：粗指针 = `sticky`（绝不主动清空输入域）；
 *   - `pickOverlayMetrics`：粗指针抬字号躲 iOS 自动放大 + 抬盒高保住 preedit；
 *   - `shouldShowPreedit`：粗指针默认 opacity 0，只在合成期露出（纯装饰镜像）；
 *   - `vtKeyClearsField`：CR/ETX 边界清空，照抄 xterm 自己在旧路径上做的事。
 *
 * ── 这一层负责什么 ──────────────────────────────────────────────────────
 * Step 0 已经把两个纯函数落地：`termInputRoute.routeKey`（一次按键归谁）与
 * `termInputModel.reduce`（输入域内容 → PTY 字节）。本文件是把它们接到真实 DOM 上
 * 的那一层，且**只做接线**：不重写规则、不复制判据。它做四件事：
 *
 *  1. 造一个 `<textarea class="vh-term-input">` 并挂进 `term.element` 内部；
 *  2. 把它定位到终端光标处（抄 xterm 自己算好的 helper textarea 几何）；
 *  3. 把它的 keydown 按 `routeKey` 分流，把它的内容变化按 `reduce` 喂进 PTY；
 *  4. 把焦点观感（`.focus` class / 光标实心 / DEC 1004 的 `ESC[I`/`ESC[O`）
 *     以**补发 FocusEvent** 的方式转交回 xterm。
 *
 * ── 三条硬纪律（照抄 spec §D，违反任何一条都会重演历史事故）───────────────
 *  1. **只补发 keydown，绝不补发 keyup。** xterm 的 `_keyUp` 里有 `this.focus()`，
 *     一个补发的 keyup 就会把键盘焦点从我们的元素抢到 xterm 的 helper textarea
 *     上 —— 之后所有真实按键都被安全带否决，表现为"打字完全没反应"。
 *  2. **安全带 `attachCustomKeyEventHandler(ev => ev.isTrusted === false)`。**
 *     真实按键（`isTrusted:true`）一旦以任何方式到达 xterm，xterm 一律不处理；
 *     只有我们补发的合成事件被处理。
 *  3. **不要用 `disableStdin`。** 它 gate 的是 `triggerDataEvent`，会把
 *     `term.paste()`（bracketed paste / 文件上传 / 预设执行）一起废掉。
 *
 * ── 为什么监听器注册在元素上，严禁 window capture ─────────────────────────
 * app 级快捷键（⌘K/⌘./⌘W/⌥W/⌘[/⌥←/⌘N/⌘1-9/⌘R、弹窗 Esc/Enter）全部是
 * `window` + capture + `preventDefault()+stopPropagation()`。DOM 派发顺序里
 * capture 从 window 往下走，天然保证它们先手；`routeKey` 的 P0 只要读
 * `defaultPrevented` 就能让位。一旦这里也注册成 window capture，两边的先后
 * 就变成注册顺序的偶然 —— 这条由 `termInputHost.test.ts` 的结构测试兜住。
 *
 * ── 卡死态不可达 ────────────────────────────────────────────────────────
 * xterm 的 `_isComposing` 只在 `CompositionHelper.compositionstart()` 里置 true，
 * 而那个方法只由 `term.textarea` 上的监听器调用。本模块的元素拿走键盘焦点后，
 * `term.textarea` 永不聚焦 ⇒ 永不收到 composition 事件 ⇒ `_isComposing` 恒 false。
 * 这条性质**不依赖我们拦对了几类事件**，所以不需要"检测 + 自愈"那一层
 * （`imeStuckGuard` 在本路径下不安装）。
 */
import type { Terminal } from '@xterm/xterm';
import { routeKey, type KeyEventLike, type RouteDecision } from './termInputRoute';
import {
    reduce,
    initialState,
    type FieldPolicyMode,
    type TermInputEvent,
    type TermInputState,
} from './termInputModel';
import { TERM_INPUT_CLASS } from './termInputElement';

// ════════════════════════════════════════════════════════════════════════
// 纯判定（零 DOM，单测直打）
// ════════════════════════════════════════════════════════════════════════

/**
 * 「合成停滞多久算病态」——**纯诊断阈值，不驱动任何动作**（2026-08-14 修正）。
 *
 * 原设计（spec「★ 宿主观测时机」第 4 条）在这里放了一条兜底：距上一次 composition
 * 事件超过 5s 就**无条件观测输入域**，理由是"保证任何病理路径下绝不永久吞字"。
 * 上线后 CDP 实证它是一条**真泄漏**：合成在途停手 6.6s（打一半去翻候选窗——
 * **翻页不产生 `compositionupdate`**，所以停手时钟照走），拉丁 preedit 被当正文
 * 灌进 PTY（实测 `"ni hao"`，随后模型自己发 6 个 `\x7f` 纠正）。
 *
 * 为什么这条兜底整条删掉而不是调阈值：它防的失效模式是"`compositionend` 永不到来
 * 导致永久吞字"，而**那个失效模式只存在于旧架构** —— 旧路径卡的是 xterm 自己那个
 * 持久标志 `_isComposing`（`termInputModel` 头注的病根）。新架构里合成状态由
 * **浏览器**持有且是准的：IME 中止时浏览器会发 `compositionend`，或者下一个 `input`
 * 的 `isComposing` 直接就是 false。用"把 preedit 当正文发出去"去防一个已不存在的
 * 问题，在终端里这笔交易方向是反的 —— 那几个字母在 vim normal mode 会被当命令吃掉，
 * 而 `\x7f` 纠正是不可逆副作用之后的补救，不是预防。
 *
 * "绝不永久吞字"改由三个**真实边界**承担（见 `shouldObserveField`）：
 * `compositionend` / 非合成 `input` / `blur`。阈值本身留下来只做一件事：
 * 合成停滞超过它时**记数不动作**（`tallyCompositionStale` → `__vhTermDiag`
 * 的 `guardCounters.compositionStaleSeen`），这样万一将来真出现"永不结束的合成"，
 * 我们能**问得出来**，而不是靠猜 —— 上次事故一半的代价就是线上问不到状态。
 */
export const COMPOSITION_STALE_MS = 5000;

/** overlay 宽度上限（spec §B）：`min(40ch, 光标到右边缘)`。 */
export const OVERLAY_MAX_CELLS = 40;

/**
 * 粗指针（手机/平板）的宽度上限。窄屏上 40 列往往就是整行，一个铺满整行的
 * 聚焦元素会给 iOS 的"为露出聚焦元素而 pan 布局视口"更多借口（spec §风险 R5）。
 * 24 列够放一句拼音，且在常见手机宽度（40-60 列）下永远不占满整行。
 */
export const OVERLAY_MAX_CELLS_COARSE = 24;

/**
 * iOS Safari 的自动放大阈值：聚焦一个**计算字号 < 16px** 的表单控件时，Safari 会
 * 把整个页面放大到让该字段可读。而放大之后 `visualViewport.scale > 1`，
 * `WebTerminalScreen.onViewport` 的第一条守卫（`scale > 1.001` 直接 return）会让
 * 软键盘避让数学**整个停摆** —— 键盘盖住终端且 `maxHeight` 再也不更新。
 *
 * 移动端字号是 12px（`MOBILE_TYPO_BASE`），正好在阈值以下，所以粗指针下 overlay
 * 的字号被抬到 16px。代价是合成中的 preedit 比终端正文略大 —— 换掉的是"页面被
 * 放大后键盘布局彻底失效"，这笔交易不用犹豫。⚠️ 这条不能用 viewport meta 的
 * `maximum-scale=1` 解决：那会**全站**禁掉双指缩放（可访问性回退）。
 */
export const IOS_ZOOM_SAFE_FONT_PX = 16;

/** 粗指针下 overlay 的行高系数：16px 字要有 20px 的盒子才不会被 `overflow:hidden` 削顶。 */
export const COARSE_LINE_FACTOR = 1.25;

/** 粗指针呈现分叉的 CSS 钩子（见 `terminal.css` 的 `.vh-term-input.is-coarse`）。 */
export const COARSE_CLASS = 'is-coarse';
/** 合成期露出 preedit 的**纯装饰**类（见 `shouldShowPreedit`）。 */
export const COMPOSING_CLASS = 'is-composing';

/**
 * 「现在该不该把输入域内容喂给模型」——**三条真实边界，没有第四条**
 * （spec「★ 宿主观测时机」，2026-08-14 删掉原第 4 条兜底 tick，理由见
 * `COMPOSITION_STALE_MS`）。
 *
 * 关键：**合成期不观测**。若合成期也观测，preedit 拼音会被回显进 PTY，
 * 与 §B ① 想要的"原生 inline preedit 画在光标处"叠字（PTY 回显的 "ni" 在下、
 * preedit 的 "ni" 在上），提交时还要看到一串退格。
 *
 * 「绝不永久吞字」由这三条各自兜住，**任意一条到达就够**（模型是单调 diff，
 * 重复到达恒 emit `''`，所以多兜零成本）：
 *  ① 非合成 `input`：IME 中止/切走/直接打字时浏览器给出的下一个 `input` 就是
 *    `isComposing:false`，它携带的是**字段全量**，diff 一次补齐所有在途文本；
 *  ② `compositionend`：正常提交（含 0ms 补跑，Safari/Firefox 晚一拍写字段）；
 *  ③ `blur`：焦点离开（失焦后 IME 不会再给我们 `compositionend`）。
 * 这三条都是**浏览器给的事实**，不是我们维护的持久标志 —— 没有"标志与现实不同步"
 * 这种失效模式，所以不再需要一个定时器去猜。
 *
 * 为什么这不违反 `termInputModel` 的铁律：铁律约束的是**模型**不得用 `composing`
 * 门控 emit；宿主选择观测时机是另一回事 —— 模型对 composition 事件无状态。
 *
 * ⚠️ `ObserveTrigger` 里**故意没有 `tick`**：这不是"tick 时返回 false"，而是让
 * "拿一个时钟来问该不该观测"在类型层面无法表达 —— 那条规则是靠时钟猜合成状态，
 * 已实证会把 preedit 当正文发出去。
 */
export type ObserveTrigger =
    | { kind: 'input'; isComposing: boolean }
    | { kind: 'composition-end' }
    | { kind: 'blur' };

export function shouldObserveField(trigger: ObserveTrigger): boolean {
    switch (trigger.kind) {
        // ① 非合成的 input：正常桌面打字、粘贴后的字段变化、死键结算、IME 中止。
        case 'input':
            return trigger.isComposing === false;
        // ② 合成结束：提交文本到位（有的浏览器要等下一拍，见 onCompositionEnd 的 0ms 补跑）。
        case 'composition-end':
            return true;
        // ③ 失焦：把在途内容提交掉，恰好一次（迟到的 end 不会重复发 —— 模型是 diff）。
        case 'blur':
            return true;
    }
}

// ── 合成停滞：只记数，不动作（见 COMPOSITION_STALE_MS）─────────────────────

export interface CompositionStaleInput {
    /** 模型当前是否认为在合成中（`state.composing`）。 */
    composing: boolean;
    now: number;
    /** 最近一次 composition 事件（start/update/end）的时刻；0 = 从未合成过。 */
    lastCompositionAt: number;
}

/**
 * 「这次合成停滞得不正常」——**纯诊断判定，调用方不许据此产生任何字节**。
 *
 * 只在合成中才有意义（非合成期字段内容早已由 ① 观测提交，"停滞"本身是正常稳态：
 * 桌面稳态下 `lastCompositionAt` 恒 0，这里恒 false，不会把稳态记成病态）。
 */
export function isCompositionStale(i: CompositionStaleInput): boolean {
    if (!i.composing) return false;
    if (i.lastCompositionAt <= 0) return false;
    return i.now - i.lastCompositionAt > COMPOSITION_STALE_MS;
}

/**
 * 停滞计数器。`seen` 只增不减（诊断用），`noted` 保证**一个停滞窗口只记一次**
 * —— 不然 250ms 一 tick，一次翻候选窗就能刷出几十条，数字失去意义。
 */
export interface CompositionStaleTally {
    seen: number;
    noted: boolean;
}

export const initialStaleTally = (): CompositionStaleTally => ({ seen: 0, noted: false });

/** tick 时调用：越过阈值就记一次（幂等到窗口结束）。**永不返回动作。** */
export function tallyCompositionStale(
    t: CompositionStaleTally,
    i: CompositionStaleInput,
): CompositionStaleTally {
    if (!isCompositionStale(i)) return t;
    if (t.noted) return t;
    return { seen: t.seen + 1, noted: true };
}

/**
 * composition 事件到达 ⇒ 停滞窗口重开（IME 又活了）。
 * 于是"打一半停手很久、再回来接着打、又停手很久"会记成 2 次，如实反映两段停滞。
 */
export function resetStaleWindow(t: CompositionStaleTally): CompositionStaleTally {
    return t.noted ? { seen: t.seen, noted: false } : t;
}

/**
 * overlay 宽度策略（spec §B）：`min(40ch, 光标到右边缘的距离)`，至少一个单元格。
 *
 * 为什么要有上限：合成中的 preedit 可能很长（整句拼音），铺满整行会盖住终端里
 * 已有的字形；40 列是"够放一句拼音、又不至于扫掉半屏"的折中。
 * 为什么要收到右边缘：超出去会触发水平滚动/换行，候选窗跟着跑偏。
 */
export function pickOverlayWidth(input: {
    cursorLeft: number;
    screenWidth: number;
    cellWidth: number;
    maxCells?: number;
}): number {
    const cell = Math.max(0, input.cellWidth);
    const maxCells = input.maxCells ?? OVERLAY_MAX_CELLS;
    const toEdge = input.screenWidth - input.cursorLeft;
    const w = Math.min(cell * maxCells, toEdge);
    // 至少一格：光标贴着右边缘时 toEdge 可能是 0/负数，宽度 0 的输入域收不到 IME。
    return Math.max(cell, w);
}

/**
 * overlay 的字号/高度/宽度 —— 桌面与粗指针**刻意不同**（spec §风险 R5，Step 2）。
 *
 * 桌面：逐字段抄 xterm 已经算好的光标单元格几何（零 typography 数学）。
 * 粗指针：只改两个数，且两个都有单一理由：
 *   - `fontSize` 抬到 16px：躲开 iOS 的聚焦自动放大（见 `IOS_ZOOM_SAFE_FONT_PX`）。
 *   - `height` 跟着抬：字大了盒子不跟着大，preedit 会被 `overflow:hidden` 削掉一半，
 *     而移动端 overlay 是合成中**唯一**的 preedit 显示面（旧路径靠 xterm 的
 *     `.composition-view` 气泡，新路径下 `CompositionHelper` 根本收不到事件）。
 * 位置（left/top）两端一律照抄光标单元格 —— 不动，因为候选窗要贴着光标。
 */
export interface OverlayMetricsInput {
    coarsePointer: boolean;
    /** 终端字号（`term.options.fontSize`）。 */
    cellFontSize: number;
    /** 光标单元格高度（抄自 xterm helper textarea 的 inline `height`）。 */
    cellHeight: number;
    cursorLeft: number;
    screenWidth: number;
    cellWidth: number;
}

export interface OverlayMetrics {
    fontSize: number;
    /** 盒子高度（同时用作 line-height：单行输入域，两者相等才不会上下偏）。 */
    height: number;
    width: number;
}

export function pickOverlayMetrics(i: OverlayMetricsInput): OverlayMetrics {
    const width = pickOverlayWidth({
        cursorLeft: i.cursorLeft,
        screenWidth: i.screenWidth,
        cellWidth: i.cellWidth,
        maxCells: i.coarsePointer ? OVERLAY_MAX_CELLS_COARSE : OVERLAY_MAX_CELLS,
    });
    if (!i.coarsePointer) {
        return { fontSize: i.cellFontSize, height: i.cellHeight, width };
    }
    const fontSize = Math.max(IOS_ZOOM_SAFE_FONT_PX, i.cellFontSize);
    const height = Math.max(i.cellHeight, Math.ceil(fontSize * COARSE_LINE_FACTOR));
    return { fontSize, height, width };
}

/**
 * 字段策略（spec §E 第 3 条）—— 两端唯一的分叉，且只是一个入参。
 *
 * 粗指针必须是 `sticky`：**绝不主动清空输入域**。OS 软键盘把这个字段当作它自己的
 * 模型（光标前有什么），清了它就认为字段已空、退格不再发事件，而 PTY 里还留着
 * 字母 —— 这就是 v1 移动桥"删不掉的最后一个字母"（`mobileInputBridge` 头注 §2）。
 * 桌面相反：硬件键盘不镜像字段内容，残字会无界增长且让 overlay 宽度策略失准。
 */
export function pickFieldPolicy(coarsePointer: boolean): FieldPolicyMode {
    return coarsePointer ? 'sticky' : 'clear-on-idle';
}

/**
 * 这个走 VT 路由的键，xterm 自己会不会顺手清空它的 textarea？
 *
 * 照抄 xterm 5.5 `_keyDown` 的原话：编码结果是 `ETX`(\x03) 或 `CR`(\r) 时执行
 * `this.textarea.value=""`。为什么要跟着做：
 *  - **视觉**：overlay 是不透明度 1 的真元素，字段里留着的整行会画在光标处，
 *    和 PTY 已经回显的同一行叠字。桌面靠 `clear-on-idle` 兜住，`sticky` 兜不住。
 *  - **安全性有实证**：旧路径上 iOS 的软键盘正是挂在这个被 xterm 在 Enter 时清空的
 *    textarea 上，而"删不掉的最后一个字母"**不是**它造成的（那是 v1 移动桥
 *    "每次发送后都清"造成的）。行末边界清空 = 键盘的上下文本来就要重开。
 *  - **退格不受影响**：退格走 VT（`\x7f`），从不依赖字段里还剩什么。
 */
export function vtKeyClearsField(ev: {
    key: string;
    ctrlKey: boolean;
    altKey: boolean;
    metaKey: boolean;
}): boolean {
    if (ev.altKey || ev.metaKey) return false;
    if (ev.key === 'Enter') return true; // → CR
    return ev.ctrlKey && ev.key.toLowerCase() === 'c'; // → ETX
}

/**
 * 合成气泡该不该显示 —— **纯装饰**（spec §B ① 末段明确允许的那种镜像）。
 *
 * **两端都用**（2026-08-14 起；原先只在粗指针下）。粗指针的理由是"静止不可见"：
 * 移动端策略是 `sticky`，字段里会留着当前这一行；一个常显的 opacity:1 元素会把
 * 这一行画在光标处，与 PTY 的回显叠字。于是移动端默认 `opacity:0`（与旧路径的
 * helper textarea 观感一致），只在合成期露出来给 preedit 用。
 *
 * 桌面新增的理由是**可辨识性**：桌面 overlay 用终端同一个字体 + 同一个前景色把
 * preedit 内联画在光标处，看起来和"已经打进终端的英文"一模一样 —— 用户据此判定
 * "中文输入法不能用"，然后按 Enter（macOS 简体拼音的 Enter = **提交原始拉丁
 * 字母**），于是真的只进去英文。旧路径没这个问题：xterm 的 `.composition-view`
 * 是个 teal 边框气泡，一眼就能看出"这是输入法在合成"。所以合成期两端都给一个
 * 同款气泡观感（`terminal.css` 的 `.vh-term-input.is-composing`），静止时桌面
 * 依旧完全不可见（`clear-on-idle` 会把字段收空）。
 *
 * 这不违反铁律：它**不参与任何字节的产生**，最坏后果是"一个空的透明框留在屏上"
 * 或"preedit 没露出来"，绝不吞键。而且它是**自过期**的 —— 每次 tick 重新求值，
 * `composition-end`/`blur` 都会把 `composing` 放掉，失焦即摘。
 */
export function shouldShowPreedit(input: { composing: boolean; focused: boolean }): boolean {
    return input.composing && input.focused;
}

/**
 * 焦点补发的判定（spec §设计 A 末条 / §风险 R2）。
 *
 * **刻意不持有我们自己的"已补发"布尔**：那正是本次改造要消灭的东西（一个持久
 * 标志一旦与现实不同步就永久错）。真相直接从 xterm 读 —— `.focus` class 由
 * `_handleTextAreaFocus`/`_handleTextAreaBlur` 维护，就是 xterm 自己的镜像状态。
 * 于是这个函数是**自愈**的：无论中间发生过什么（比如 xterm 内部 `this.focus()`
 * 把焦点抢走一瞬又被我们抢回来），下一次求值都会把两边对齐，且**不会重复上报**。
 */
export type FocusMirrorAction = 'none' | 'focus' | 'blur';

export function mirrorFocusAction(xtermFocused: boolean, ownFocused: boolean): FocusMirrorAction {
    if (ownFocused === xtermFocused) return 'none';
    return ownFocused ? 'focus' : 'blur';
}

/** `localSettings.terminalInputOwnership` 的取值。 */
export type InputOwnership = 'xterm' | 'own';

/**
 * 生效的输入路径 = 设置 ⊕ URL 一次性覆盖。**与设备无关**（Step 2 起）。
 *
 *  - `?input=own|xterm` 一次性覆盖设置（CDP golden 差分要在**同一构建**上跑两条路径）；
 *  - Step 1 曾有一条"粗指针强制旧路径"的设备门，理由是那时移动端还只有
 *    `mobileInputBridge` 这一条路，两条同时激活 = 一次按键写两遍 PTY（spec §R4）。
 *    Step 2 把移动端接到同一条自有路径上，互斥改由**唯一的一个开关**保证：
 *    `own` ⇒ 装 overlay、不装 `mobileInputBridge`；`xterm` ⇒ 反之。设备不再进这个判断
 *    —— 一个判据两处写就是下一次"两条路径同时活着"的入口。
 */
export function resolveInputOwnership(input: {
    setting: InputOwnership | undefined;
    urlParam: string | null | undefined;
}): InputOwnership {
    const url = input.urlParam;
    if (url === 'own' || url === 'xterm') return url;
    return input.setting === 'own' ? 'own' : 'xterm';
}

// ════════════════════════════════════════════════════════════════════════
// 宿主（DOM 接线）
// ════════════════════════════════════════════════════════════════════════

/** 路由诊断的记录口（`termInputDiag` 实现；生产默认不挂）。 */
export interface TermInputRouteRecorder {
    noteRouted(ev: KeyEventLike, decision: RouteDecision): void;
}

export interface TermInputHostOptions {
    term: Terminal;
    /** 唯一写 PTY 出口（`WebTerminalScreen` 的 `sendInput`）。 */
    sendInput: (data: string) => void;
    /** 复用 xterm 的按键编码器（`renderer.sendKey`：向 `term.textarea` 补发合成 keydown）。 */
    sendKey: (ev: KeyboardEvent) => void;
    /** bracketed paste（`renderer.paste` → `term.paste`，自带防注入与换行归一）。 */
    paste: (text: string) => void;
    isMac: boolean;
    /** 终端前景色（来自 `WebTerminalScreen` 的 THEME，避免这里裸写色值）。 */
    foreground: string;
    /**
     * 粗指针（手机/平板）。只影响**呈现与几何**（字号/高度/宽度上限、合成期才露出），
     * 不影响路由表、不影响模型 —— 两端共用同一个核心（spec §F）。
     */
    coarsePointer?: boolean;
    /**
     * 输入行模式（`send-line` 路由的开关）。
     *
     * ⚠️ Step 2 的结论：**两端都恒 false，overlay 永远是逐键面**。
     * 输入行模式的输入面是 `TermInputBar` 自己的 `<textarea>`，它挂在
     * `.term-bottombars` 里、**在 `term.element` 之外**，本宿主的监听器一个都碰不到它；
     * 它的整行发送直接走屏幕的 `sendInput`。所以"整行先被增量 emit 一遍、Enter 再补
     * `\r`"这种双发在结构上不可能发生 —— 两个输入面是不相交的 DOM 元素。
     * 保留这个入参是为了让 `routeKey` 的 P6 仍可被单测覆盖，以及给未来"桌面也用输入行
     * 模式"（spec §B ③）留口子。
     */
    barMode?: () => boolean;
    policy?: FieldPolicyMode;
    diag?: TermInputRouteRecorder;
    /** 兜底 tick 周期：驱动 clear-on-idle、几何同步与 ★ 规则 4。 */
    tickMs?: number;
    now?: () => number;
}

export interface TermInputHostHandle {
    readonly element: HTMLTextAreaElement;
    focus(): void;
    blur(): void;
    isFocused(): boolean;
    /**
     * 是否正在合成 —— **只**给焦点看门狗用（"合成期不动焦点"）。
     * 绝不参与"是否发送文本"的判断，见 `termInputModel` 的铁律。
     */
    isComposing(): boolean;
    /**
     * 只读诊断计数器（进 `__vhTermDiag.guardCounters`）。**没有任何一条是闸门**
     * —— 见 `COMPOSITION_STALE_MS`：把"记数"和"动作"分开正是这次修正的要点。
     */
    readonly counters: { readonly compositionStaleSeen: number };
    dispose(): void;
}

export function installTermInput(opts: TermInputHostOptions): TermInputHostHandle | null {
    const term = opts.term;
    const root = term.element;
    const xtermTa = term.textarea;
    if (!root || !xtermTa) return null;

    const now = opts.now ?? (() => Date.now());
    const tickMs = opts.tickMs ?? 250;

    // 挂进 `.xterm-helpers`（`term.element` 的子节点）。两个理由：
    //  1. **必须在 `term.element` 内部**：xterm 把 `copy`/`paste`/`contextmenu`
    //     绑在 `this.element` 上，只有作为后代，⌘C 复制选区与 host 层的文件粘贴
    //     capture 才继续免费生效（spec §风险 R6）。
    //  2. `.xterm-helpers` 是 `position:absolute; top:0; z-index:5`（xterm.css），
    //     与 helper textarea 的 inline `left/top` **同一个坐标原点** —— 于是几何
    //     可以逐字段抄过来，零 typography 数学；z-index 5 又保证 preedit 画在
    //     行内容之上。
    const helpers = (root.querySelector('.xterm-helpers') as HTMLElement | null) ?? root;

    const el = document.createElement('textarea');
    el.className = TERM_INPUT_CLASS;
    el.rows = 1;
    // 软换行会让长 preedit 视觉上折到第二行（元素只有一个单元格高，折下去的部分
    // 直接被 overflow:hidden 吃掉）。`white-space:pre` 管的是渲染，`wrap="off"`
    // 管的是 textarea 自己的换行行为，两个都要。
    el.wrap = 'off';
    el.setAttribute('autocomplete', 'off');
    el.setAttribute('autocorrect', 'off');
    el.setAttribute('autocapitalize', 'off');
    el.setAttribute('spellcheck', 'false');
    el.setAttribute('aria-label', 'Terminal input');
    // 软键盘提示（旧路径由 `mobileInputBridge` 写在 xterm 的 helper textarea 上；
    // 那条路径在 `own` 下不安装，所以提示必须搬到这里，否则 iOS 可能给出
    // 带自动大写/表单语义的键盘）。硬件键盘上这两个属性无副作用。
    el.setAttribute('inputmode', 'text');
    el.setAttribute('enterkeyhint', 'send');
    const coarse = opts.coarsePointer === true;
    // 粗指针的呈现分叉（见 `shouldShowPreedit`）：默认不透明度 0，合成期才露出。
    if (coarse) el.classList.add(COARSE_CLASS);
    helpers.appendChild(el);

    // 安全带（spec §D 纪律 2）。真实按键一旦以任何方式到达 xterm 一律不处理 ——
    // 包括 `_keyUp` 里那个会抢焦点的 `this.focus()`。
    term.attachCustomKeyEventHandler((ev) => ev.isTrusted === false);

    let state: TermInputState = initialState(opts.policy ?? 'clear-on-idle');
    /** 最近一次 composition 事件的时刻。**只喂诊断计数器**，不参与任何 emit 判断。 */
    let lastCompositionAt = 0;
    let stale: CompositionStaleTally = initialStaleTally();
    let disposed = false;
    let commitTimer: ReturnType<typeof setTimeout> | null = null;

    const apply = (ev: TermInputEvent): void => {
        const r = reduce(state, ev);
        state = r.state;
        if (r.emit) opts.sendInput(r.emit);
        if (r.clearField) {
            el.value = '';
            // 回读实际值对齐 shadow（`adopt` 语义：只对齐基准，绝不发送）。
            state = reduce(state, { type: 'adopt', value: el.value }).state;
        }
    };

    /** 观测一次输入域 —— emit 的**唯一**触发点（除去显式的 VT 路由）。幂等。 */
    const observe = (): void => {
        if (disposed) return;
        apply({ type: 'field-value', value: el.value, at: now() });
    };

    // ── 焦点补发（spec §设计 A / §风险 R2）─────────────────────────────────
    // xterm 的监听器不校验 `isTrusted`，于是 `.focus` class、`_showCursor()`、
    // `CoreBrowserService._isFocused`（决定实心块 vs outline 光标）、以及
    // `sendFocusMode` 下的 `ESC[I`/`ESC[O` 全部按原样工作。
    const xtermThinksFocused = (): boolean => root.classList.contains('focus');
    const syncMirror = (): void => {
        if (disposed) return;
        const action = mirrorFocusAction(xtermThinksFocused(), document.activeElement === el);
        if (action === 'none') return;
        xtermTa.dispatchEvent(new FocusEvent(action));
    };

    // ── keydown：按 `routeKey` 的 kind 分流 ────────────────────────────────
    const onKeyDown = (ev: KeyboardEvent): void => {
        const decision = routeKey(ev as unknown as KeyEventLike, {
            isMac: opts.isMac,
            barMode: opts.barMode?.() === true,
            modes: {
                applicationCursorKeysMode: term.modes.applicationCursorKeysMode,
                applicationKeypadMode: term.modes.applicationKeypadMode,
            },
        });
        opts.diag?.noteRouted(ev as unknown as KeyEventLike, decision);
        // `preventDefault` 与 kind 是同一张表钉死的（`vt`/`send-line` ⇔ true），
        // 这里照抄决定，不再二次判断 —— 少一处可以和表走偏的地方。
        if (decision.preventDefault) ev.preventDefault();
        if (decision.kind === 'vt') {
            opts.sendKey(ev);
            // 行边界清空：照抄 xterm 自己在 CR/ETX 上做的事（见 `vtKeyClearsField`）。
            // VT 键被 preventDefault 掉了，输入域不会自己变空，而 `sticky` 又永不主动
            // 清 —— 不做这一步，移动端的字段会把整条命令一直留在光标处画出来。
            // 清空恒不发字节（`adopt` 语义），合成期由模型自己拒绝。
            if (vtKeyClearsField(ev)) apply({ type: 'clear-request' });
            return;
        }
        if (decision.kind === 'send-line') {
            sendLine();
            return;
        }
        // app / ime / clipboard / text / ignore：一律不动。
        // - `ime`/`text` 放行给输入域 → `input` → diff → PTY；
        // - `clipboard` 放行给原生 copy/paste 事件（在 keydown 上 preventDefault
        //   反而会把真正搬运数据的那个事件掐掉）；
        // - `app` 是上层已消费，`ignore` 是既不产字符也无 VT 语义。
    };

    /** 输入行模式的 Enter：整行 + `\r`。 */
    const sendLine = (): void => {
        // 先把尚未观测的字段内容补齐（正常路径下这里 emit 为空 —— 每个非合成
        // `input` 都已经观测过了），再补一个 CR，顺序与 pty 上看到的一致。
        observe();
        apply({ type: 'clear-request' });
        opts.sendInput('\r');
    };

    // ── 输入域事件：★ 宿主观测时机的四条规则 ───────────────────────────────
    const onInput = (ev: Event): void => {
        const isComposing = (ev as InputEvent).isComposing === true;
        if (!shouldObserveField({ kind: 'input', isComposing })) return;
        observe();
    };
    const onCompositionStart = (): void => {
        lastCompositionAt = now();
        stale = resetStaleWindow(stale);
        apply({ type: 'composition-start' });
        syncPreedit();
    };
    const onCompositionUpdate = (): void => {
        // **一个字节都不读**：`compositionupdate.data` 从不参与输入通路
        // （spec §B ① 的"零 JS 镜像"）。这里只更新诊断用的停滞时钟。
        // ⚠️ 注意它**不是**"合成还活着"的可靠信号：在候选窗里翻页不产生
        // `compositionupdate`，所以停手时钟照走 —— 原兜底 tick 正是踩在这上面。
        lastCompositionAt = now();
        stale = resetStaleWindow(stale);
    };
    const onCompositionEnd = (): void => {
        lastCompositionAt = now();
        apply({ type: 'composition-end' });
        syncPreedit();
        observe();
        // Safari/Firefox 在 `compositionend` **之后**才把提交文本写进字段
        // （Chrome 在之前）；xterm 自己也用 0ms 定时器读。observe 幂等，
        // 多跑一次零成本，少跑一次就要等下一个 input 或 5s 兜底。
        if (commitTimer != null) clearTimeout(commitTimer);
        commitTimer = setTimeout(() => {
            commitTimer = null;
            observe();
        }, 0);
    };
    const onFocus = (): void => {
        apply({ type: 'focus' });
        syncMirror();
        syncPreedit();
    };
    const onBlur = (): void => {
        // 顺序要紧：先 `blur` 解除 composing（失焦后 IME 不会再给 `compositionend`
        // ——"切输入法就打不了中文"的现场），再观测把在途内容提交掉。
        apply({ type: 'blur' });
        observe();
        syncMirror();
        syncPreedit();
    };

    // ── 粘贴：纯文本走 `term.paste()`，含 files 的一概不碰 ──────────────────
    const onPaste = (ev: ClipboardEvent): void => {
        // 含 files 的粘贴由 host 层的 capture 监听器先手（它 stopImmediatePropagation，
        // 正常根本到不了这里）；万一到了也让它继续走既有上传路径。
        const files = ev.clipboardData?.files;
        if (files && files.length > 0) return;
        const text = ev.clipboardData?.getData('text') ?? '';
        ev.preventDefault();
        // **刻意复用 `term.paste()`**：自带 `prepareTextForTerminal`（换行归一）
        // + `bracketTextForPaste`（按 bracketedPasteMode 包裹，并剥离载荷里的
        // `ESC[201~` 防注入）。自己往输入域塞文本会绕过这两层。
        if (text) opts.paste(text);
    };

    // ── xterm 抢焦点的兜底 ────────────────────────────────────────────────
    // 我们的元素是 `pointer-events:none`（否则会挡住光标附近的拖选，spec §R6），
    // 所以点击终端仍然走 xterm 自己的 mousedown → `this.focus()` → helper
    // textarea 拿到焦点。此时真实按键会被安全带全部否决 = "打字没反应"。
    // 这里把焦点弹回我们的元素，然后 `syncMirror()` 自愈地把 xterm 的
    // `.focus` 状态补回去（它刚被原生 blur 清掉）。
    //
    // 不会自激：`el.focus()` 触发的 focusin 目标是 el，第一行就返回。
    // 也不会被我们补发的 FocusEvent 触发：`new FocusEvent('focus')` 的
    // `bubbles` 默认 false，不产生 focusin。
    const onFocusIn = (ev: FocusEvent): void => {
        if (ev.target !== xtermTa) return;
        el.focus({ preventScroll: true });
        syncMirror();
    };

    // ── 几何：抄 xterm 已经算好的光标单元格 ────────────────────────────────
    // `_syncTextArea()` 每次 `onCursorMove` 把 helper textarea 的 inline
    // `left/top/width/height/lineHeight` 设到光标单元格。我们订阅**公开的**
    // `term.onCursorMove`，把这些值抄过来（外加 §B 的宽度策略）。
    // 零私有 API、零 typography 数学；移动端键盘态换字号也自动跟随。
    const syncGeometry = (): void => {
        if (disposed) return;
        const s = xtermTa.style;
        el.style.left = s.left || '0px';
        el.style.top = s.top || '0px';
        el.style.fontFamily = String(term.options.fontFamily ?? '');
        el.style.color = opts.foreground;
        const screen = root.querySelector('.xterm-screen') as HTMLElement | null;
        const screenWidth = screen?.clientWidth ?? root.clientWidth;
        const cellWidth = term.cols > 0 ? screenWidth / term.cols : 0;
        const m = pickOverlayMetrics({
            coarsePointer: coarse,
            cellFontSize: Number(term.options.fontSize ?? 0) || 0,
            cellHeight: parseFloat(s.height || '0') || 0,
            cursorLeft: parseFloat(s.left || '0') || 0,
            screenWidth,
            cellWidth,
        });
        if (m.fontSize > 0) el.style.fontSize = `${m.fontSize}px`;
        // 高度与行高同值：单行输入域，两者一致 preedit 才不会上下偏。尚未测出
        // 单元格尺寸（首帧、fit 之前）时不写，免得把元素压成 0 高度收不到 IME。
        if (m.height > 0) {
            el.style.height = `${m.height}px`;
            el.style.lineHeight = `${m.height}px`;
        }
        el.style.width = `${m.width}px`;
    };

    /**
     * 合成气泡的**纯装饰**同步（两端都做，见 `shouldShowPreedit`）。
     * 每个 composition/焦点事件与每个 tick 都重新求值 ⇒ 自过期，不可能卡住。
     */
    const syncPreedit = (): void => {
        if (disposed) return;
        const on = shouldShowPreedit({
            composing: state.composing,
            focused: document.activeElement === el,
        });
        el.classList.toggle(COMPOSING_CLASS, on);
    };

    el.addEventListener('keydown', onKeyDown);
    el.addEventListener('input', onInput);
    el.addEventListener('compositionstart', onCompositionStart);
    el.addEventListener('compositionupdate', onCompositionUpdate);
    el.addEventListener('compositionend', onCompositionEnd);
    el.addEventListener('focus', onFocus);
    el.addEventListener('blur', onBlur);
    el.addEventListener('paste', onPaste);
    root.addEventListener('focusin', onFocusIn);
    const cursorDisp = term.onCursorMove(syncGeometry);
    const resizeDisp = term.onResize(syncGeometry);
    syncGeometry();

    // 唯一的定时器。它**不观测输入域** —— 观测只由三个真实边界触发
    // （`shouldObserveField`；原第 4 条"停滞就无条件观测"已删，见
    // `COMPOSITION_STALE_MS`）。定时器只做三件不产生字节的事：
    // 模型的 clear-on-idle `tick`、几何重算（字号/布局变化不一定伴随
    // `onCursorMove`）、以及合成停滞的**记数**。
    const timer = setInterval(() => {
        if (disposed) return;
        const t = now();
        stale = tallyCompositionStale(stale, {
            composing: state.composing,
            now: t,
            lastCompositionAt,
        });
        apply({ type: 'tick', now: t });
        syncGeometry();
        syncPreedit();
    }, tickMs);

    return {
        element: el,
        focus: () => el.focus({ preventScroll: true }),
        blur: () => el.blur(),
        isFocused: () => document.activeElement === el,
        isComposing: () => state.composing,
        counters: {
            get compositionStaleSeen() { return stale.seen; },
        },
        dispose() {
            disposed = true;
            clearInterval(timer);
            if (commitTimer != null) clearTimeout(commitTimer);
            cursorDisp.dispose();
            resizeDisp.dispose();
            root.removeEventListener('focusin', onFocusIn);
            el.remove();
            // 摘掉安全带，让 xterm 恢复默认（`true` = 照常处理）。开关翻回
            // `'xterm'` 时整个 renderer 会重建，这里只是不留脏状态。
            term.attachCustomKeyEventHandler(() => true);
        },
    };
}
