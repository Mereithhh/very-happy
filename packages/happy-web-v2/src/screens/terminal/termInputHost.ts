/**
 * termInputHost —— 自有输入元素的**宿主**（spec §设计 A/B/C 的接线层，Step 1）
 *
 * spec: `specs/2026-08-terminal-input-ownership.md`
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
 * ★ 宿主观测时机的兜底阈值（spec「★ 宿主观测时机」第 4 条）。
 *
 * 距上一次 composition 事件超过这么久，就**无条件**观测一次输入域 —— 一个
 * **自过期的有界看门狗**（与 `termFocusOwnership` 的合成布尔同款）。
 * 它存在的唯一理由：保证任何病理路径（`compositionend` 永不到达、输入法不发
 * composition 事件、事件乱序）下，已经打进输入域的文本最多迟到 5s，
 * **绝不永久吞字**。注意它不是"闸门"——正常路径根本走不到它。
 */
export const COMPOSITION_STALE_MS = 5000;

/** overlay 宽度上限（spec §B）：`min(40ch, 光标到右边缘)`。 */
export const OVERLAY_MAX_CELLS = 40;

/**
 * 「现在该不该把输入域内容喂给模型」——spec「★ 宿主观测时机」的四条规则。
 *
 * 关键：**合成期不观测**。若合成期也全量观测，preedit 拼音会被回显进 PTY，
 * 与 §B ① 想要的"原生 inline preedit 画在光标处"叠字（PTY 回显的 "ni" 在下、
 * preedit 的 "ni" 在上），提交时还要看到一串退格。
 *
 * 为什么这不违反 `termInputModel` 的铁律：铁律约束的是**模型**不得用 `composing`
 * 门控 emit；宿主选择观测时机是另一回事 —— 模型对 composition 事件无状态，
 * 即使 `compositionend` 永远不来，下一次非合成 `input` 携带的**完整 diff**
 * 也会一次性补齐。
 */
export type ObserveTrigger =
    | { kind: 'input'; isComposing: boolean }
    | { kind: 'composition-end' }
    | { kind: 'blur' }
    | { kind: 'tick'; now: number; lastCompositionAt: number };

export function shouldObserveField(trigger: ObserveTrigger): boolean {
    switch (trigger.kind) {
        // ① 非合成的 input：正常桌面打字、粘贴后的字段变化、死键结算。
        case 'input':
            return trigger.isComposing === false;
        // ② 合成结束：提交文本到位（有的浏览器要等下一拍，见 onCompositionEnd 的 0ms 补跑）。
        case 'composition-end':
            return true;
        // ③ 失焦：把在途内容提交掉，恰好一次（迟到的 end 不会重复发 —— 模型是 diff）。
        case 'blur':
            return true;
        // ④ 兜底 tick：自过期看门狗，见 COMPOSITION_STALE_MS。
        case 'tick':
            return trigger.now - trigger.lastCompositionAt > COMPOSITION_STALE_MS;
    }
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
 * 生效的输入路径 = 设置 ⊕ URL 一次性覆盖 ⊕ Step 1 的设备门。
 *
 *  - `?input=own|xterm` 一次性覆盖设置（CDP golden 差分要在**同一构建**上跑两条路径）；
 *  - Step 1 只做桌面：粗指针设备（手机/平板）强制走旧路径，否则会和
 *    `mobileInputBridge` 同时激活 = 一次按键写两遍 PTY（spec §风险 R4）。
 *    移动端在 Step 2 接同一路径时删掉这一条。
 */
export function resolveInputOwnership(input: {
    setting: InputOwnership | undefined;
    urlParam: string | null | undefined;
    coarsePointer: boolean;
}): InputOwnership {
    if (input.coarsePointer) return 'xterm';
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
    /** 输入行模式（Step 1 桌面恒 false；Step 2 移动端接入时才可能为真）。 */
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
    helpers.appendChild(el);

    // 安全带（spec §D 纪律 2）。真实按键一旦以任何方式到达 xterm 一律不处理 ——
    // 包括 `_keyUp` 里那个会抢焦点的 `this.focus()`。
    term.attachCustomKeyEventHandler((ev) => ev.isTrusted === false);

    let state: TermInputState = initialState(opts.policy ?? 'clear-on-idle');
    let lastCompositionAt = 0;
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
        apply({ type: 'composition-start' });
    };
    const onCompositionUpdate = (): void => {
        // **一个字节都不读**：`compositionupdate.data` 从不参与输入通路
        // （spec §B ① 的"零 JS 镜像"）。这里只给兜底 tick 续命。
        lastCompositionAt = now();
    };
    const onCompositionEnd = (): void => {
        lastCompositionAt = now();
        apply({ type: 'composition-end' });
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
    };
    const onBlur = (): void => {
        // 顺序要紧：先 `blur` 解除 composing（失焦后 IME 不会再给 `compositionend`
        // ——"切输入法就打不了中文"的现场），再观测把在途内容提交掉。
        apply({ type: 'blur' });
        observe();
        syncMirror();
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
        if (s.height) el.style.height = s.height;
        if (s.lineHeight) el.style.lineHeight = s.lineHeight;
        el.style.fontFamily = String(term.options.fontFamily ?? '');
        if (term.options.fontSize) el.style.fontSize = `${term.options.fontSize}px`;
        el.style.color = opts.foreground;
        const screen = root.querySelector('.xterm-screen') as HTMLElement | null;
        const screenWidth = screen?.clientWidth ?? root.clientWidth;
        const cellWidth = term.cols > 0 ? screenWidth / term.cols : 0;
        el.style.width = `${pickOverlayWidth({
            cursorLeft: parseFloat(s.left || '0') || 0,
            screenWidth,
            cellWidth,
        })}px`;
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

    // 唯一的定时器：驱动 ★ 规则 4（兜底观测）、模型的 clear-on-idle `tick`、
    // 以及几何重算（字号/布局变化不一定伴随 onCursorMove）。
    const timer = setInterval(() => {
        if (disposed) return;
        const t = now();
        if (shouldObserveField({ kind: 'tick', now: t, lastCompositionAt })) observe();
        apply({ type: 'tick', now: t });
        syncGeometry();
    }, tickMs);

    return {
        element: el,
        focus: () => el.focus({ preventScroll: true }),
        blur: () => el.blur(),
        isFocused: () => document.activeElement === el,
        isComposing: () => state.composing,
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
