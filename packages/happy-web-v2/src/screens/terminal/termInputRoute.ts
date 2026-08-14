/**
 * termInputRoute —— 终端键盘事件的路由判定表（纯函数，spec §设计 C 的直译）
 *
 * spec: `specs/2026-08-terminal-input-ownership.md` §C「非文本键路由：判定优先级表」
 * Step 0：**只有判定，没有接线**。本文件零 DOM、零定时器、零 import 副作用。
 *
 * ── 这张表要解决什么 ────────────────────────────────────────────────────
 * 输入所有权改造后，keydown 由**我们自己的输入元素**接收（不是 xterm 的 helper
 * textarea）。一次按键只能有一个归宿：进 PTY（VT 编码器）、进输入域（让浏览器/
 * IME 产字符，再由 `termInputModel` 的单调 diff 送进 PTY）、给上层/系统、或丢弃。
 * 两条最容易出事的边：
 *   - **双通路**：既 preventDefault 走 VT，又让输入域收到 ⇒ 字符双发（spec §风险 R4）；
 *   - **静默失效**：既没 preventDefault 也没人编码 ⇒ 这个键什么都不发（spec §风险 R3）。
 * 所以每条规则同时钉死两件事：`kind`（谁负责）与 `preventDefault`（要不要吃掉默认行为）。
 * 不变式（单测表驱动全覆盖）：**`kind==='vt'` 或 `'send-line'` ⇔ `preventDefault===true`**，
 * 其余一律 false。
 *
 * ── 为什么 P1 是根治的核心 ──────────────────────────────────────────────
 * IME 失效复发三次的共同结构是：**用一个持久标志当闸门**（xterm 的 `_isComposing`
 * 靠成对的 `compositionend` 关闭，一旦缺失就永久 true，之后所有 229 键被静默吞掉）。
 * P1 的判据 `isComposing / keyCode===229 / key==='Process'` **全部来自事件对象本身**，
 * 不读任何持久状态、也不写任何持久状态 ⇒ 「事件缺失」在数学上不可能让路由卡死：
 * 每一次 keydown 的判定只依赖那一次 keydown。这是「无状态判据」，也是这张表最重要
 * 的一条 —— 任何把 P1 改成读某个 `composing` 布尔的"优化"都会把 bug 请回来。
 *
 * ── 结构约束 ────────────────────────────────────────────────────────────
 * 宿主必须把 handler 注册在**输入元素**上，严禁 window capture：app 级快捷键
 * （⌘K/⌘./⌘W/⌥W/⌘[/⌥←/⌘N/⌘1-9/⌘R、弹窗 Esc/Enter）全部是 window+capture 且
 * `preventDefault()+stopPropagation()`，DOM 派发顺序天然保证它们先手 —— P0 只需读
 * `defaultPrevented` 就能让位。此约束由 `termInputRoute.test.ts` 的结构测试兜住。
 */

/**
 * 鸭子类型的 keydown 事件：测试环境是 node（无 jsdom），判定只许读这些字段。
 * 字段集与真实 `KeyboardEvent` 同名同义，宿主可以直接把事件传进来。
 */
export interface KeyEventLike {
    /** `KeyboardEvent.key`：字符键为该字符本身（长度 1），功能键为名字。 */
    key: string;
    /** `KeyboardEvent.code`：物理键位，与布局/修饰无关（⌥W 的 key 是 `∑`，code 仍是 `KeyW`）。 */
    code: string;
    /** 传统 keyCode。软键盘/IME 的哨兵值 229 只在这里可见（`key` 常常是 `Unidentified`）。 */
    keyCode?: number;
    isComposing?: boolean;
    defaultPrevented?: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    /** `DOM_KEY_LOCATION_*`：3 = 数字小键盘。 */
    location?: number;
}

export interface RouteCtx {
    /** 平台：决定 ⌥ 是「产字符的第三级 shift」（mac）还是「Meta 前缀」（其余）。 */
    isMac: boolean;
    /** 输入行模式（`localSettings.terminalInputBarMode`）：Enter 送整行而不是裸 `\r`。 */
    barMode: boolean;
    /** xterm 的公开 `term.modes` 子集。 */
    modes: {
        /** DECCKM。**当前不参与路由**，见文件末尾的说明。 */
        applicationCursorKeysMode: boolean;
        /** DECKPAM：开启时小键盘按键必须走 VT 编码（SS3），不能落进输入域。 */
        applicationKeypadMode: boolean;
    };
}

export type RouteKind =
    /** P0：上层 window-capture 已经消费掉了，我们完全不介入。 */
    | 'app'
    /** P1：IME 拥有这一击，放行给输入域与输入法，不路由、不记状态。 */
    | 'ime'
    /** P2/P3：剪贴板语义，不进 PTY；由原生 copy/paste 事件承接。 */
    | 'clipboard'
    /** P5：非文本键/控制组合，交给 VT 编码器 → PTY。 */
    | 'vt'
    /** P4/P7：交给输入域产字符，再由 `termInputModel` 的单调 diff 进 PTY。 */
    | 'text'
    /** P8：既不产字符也无 VT 语义。 */
    | 'ignore'
    /** P6：输入行模式的 Enter —— 送整行 `text + \r`。 */
    | 'send-line';

export interface RouteDecision {
    kind: RouteKind;
    preventDefault: boolean;
}

/** 只有「我们要自己发字节」的两类才吃掉默认行为，其余一律放行（见 R3/R4）。 */
function decide(kind: RouteKind): RouteDecision {
    return { kind, preventDefault: kind === 'vt' || kind === 'send-line' };
}

/** P2 里放行给原生的四个 ⌘ 组合（复制/粘贴/剪切/全选）。 */
const META_CLIPBOARD_KEYS = new Set(['c', 'v', 'x', 'a']);

/**
 * P5 的具名非文本键。方向键/Home/End/PageUp/PageDown 无论有无修饰都在这里：
 * DECCKM（`applicationCursorKeysMode`）只改**编码**，不改归属，编码由 VT 编码器
 * （Phase 1 = xterm 的 `evaluateKeyboardEvent`，spec §D）自己查模式。
 */
const VT_NAMED_KEYS = new Set([
    'Enter', 'Tab', 'Backspace', 'Delete', 'Escape',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Home', 'End', 'PageUp', 'PageDown', 'Insert',
]);

/** P8 的纯修饰键。必须早于 P5 的 ctrl 兜底判定 —— 修饰键自身的 keydown 也带 `ctrlKey:true`。 */
const MODIFIER_KEYS = new Set([
    'Control', 'Shift', 'Alt', 'Meta', 'CapsLock',
    'NumLock', 'ScrollLock', 'Fn', 'FnLock', 'Super', 'Hyper', 'Symbol', 'AltGraph',
]);

/** F1-F12 有 VT 序列；F13+ 没有（落 P8）。 */
const F1_TO_F12 = /^F([1-9]|1[0-2])$/;

/**
 * 「这一击最终由输入域产字符」：单字符键，外加两个**不产字符但必须让输入域看见**的
 * 特例 —— `Dead`（死键 ´ + e = é，合成的第一拍）与 `Unidentified`。
 * 注：spec P7 的判据只写了 `key.length === 1`，但同一行的依据点名了死键；死键的
 * `key` 是 `'Dead'`（长度 4），照字面实现会落进 P8。这里按依据修正，见文件末尾。
 */
function isFieldBorne(ev: KeyEventLike): boolean {
    return ev.key.length === 1 || ev.key === 'Dead' || ev.key === 'Unidentified';
}

/**
 * 按 spec §C 的表**按序短路**，第一条命中即停。
 * 纯函数：同一 `(ev, ctx)` 恒返回同一结果，不读写任何模块级状态。
 */
export function routeKey(ev: KeyEventLike, ctx: RouteCtx): RouteDecision {
    // ── P0 ── app 层 window-capture 已消费（⌘K/⌘./⌘W/⌥W/⌘[/⌥←/⌘N/⌘1-9/⌘R、
    // 弹窗 Esc/Enter）。它们都 preventDefault+stopPropagation，我们只需让位。
    if (ev.defaultPrevented === true) return decide('app');

    // ── P1 ── IME 拥有这一击：完全放行，不 preventDefault、不路由、不记状态。
    // **无状态判据**（判据全部来自事件本身）—— 这是根治的核心，见文件头。
    // Android 软键盘每一击都是 229，也正好该走输入域路径。
    if (ev.isComposing === true || ev.keyCode === 229 || ev.key === 'Process') return decide('ime');

    // ── P2 ── ⌘ 组合一律不进 PTY（xterm 自己也从不把 meta 组合转发给 PTY）。
    // ⌘C/⌘V/⌘X/⌘A 不 preventDefault：放行给原生 → 冒泡到 xterm element 级的
    // copyHandler / 触发原生 paste 事件（我们的 paste 处理走 `term.paste()`）。
    if (ev.metaKey === true) {
        if (!ev.ctrlKey && !ev.altKey && META_CLIPBOARD_KEYS.has(ev.key.toLowerCase())) {
            return decide('clipboard');
        }
        return decide('ignore');
    }

    // ── P3 ── Linux/Windows 终端惯例：Ctrl+Shift+C/V 与 Shift+Insert 是剪贴板语义。
    // 同样不 preventDefault —— 真正搬运数据的是随后的原生 copy/paste 事件，
    // 在 keydown 上 preventDefault 反而会把它掐掉。
    // （mac 上 ⌃⇧C 不是剪贴板：它落 P5 的 ctrl 兜底，与 xterm 行为一致——什么都不发。）
    if (!ctx.isMac && ev.ctrlKey && ev.shiftKey && !ev.altKey
        && (ev.key === 'C' || ev.key === 'c' || ev.key === 'V' || ev.key === 'v')) {
        return decide('clipboard');
    }
    if (ev.shiftKey && !ev.ctrlKey && !ev.altKey && ev.key === 'Insert') return decide('clipboard');

    // ── P4 ── mac 的 ⌥ 是第三级 shift（`macOptionIsMeta` 保持 false）：⌥w 产出 `∑`。
    // 落到 P7 的处置（不 preventDefault，交给输入域），必须**早于** P5 求值，
    // 否则 ⌥+方向键之外的 ⌥+字符会被 P5 的兜底吃掉。
    // 非 mac 的 Alt 语义相反（= Meta 前缀，ESC+char），在 P5 里处理。
    if (ctx.isMac && ev.altKey && !ev.ctrlKey && !ev.metaKey && isFieldBorne(ev)) return decide('text');

    // ── P8（提前）── 纯修饰键自身的 keydown 也带 `ctrlKey/altKey:true`，
    // 必须在 P5 的 ctrl/alt 兜底之前摘掉，否则 ⌃ 单击会被当成一次 VT 键。
    if (MODIFIER_KEYS.has(ev.key)) return decide('ignore');

    // ── P6 ── 输入行模式的 Enter 送整行。**必须早于 P5**：P5 的具名集合含 `Enter`，
    // 照 spec 的表序（P5 在前）P6 会是死代码。spec 同一行的依据「就地模式下 Enter
    // 落 P5 送 \r」说明意图正是「barMode 时 Enter 归 P6」，这里按意图实现。
    if (ctx.barMode && ev.key === 'Enter' && !ev.ctrlKey && !ev.altKey) {
        // Shift+Enter = 在输入行里换行（`TermInputBar` 的既有语义），归输入域。
        if (ev.shiftKey) return decide('text');
        return decide('send-line');
    }

    // ── P5 ── 非文本键与控制组合：preventDefault + 交给 VT 编码器 → PTY。
    // `Tab` 必须 preventDefault（否则焦点跑掉、claude 的补全没了）；
    // `Ctrl+C` 无论有无选区都送 `\x03`（选区复制走 ⌘C / P3）。
    if (VT_NAMED_KEYS.has(ev.key)) return decide('vt');
    if (F1_TO_F12.test(ev.key)) return decide('vt');
    // Ctrl 兜底（含 Ctrl+字母、Ctrl+[ ] \ ^ _ Space、Ctrl+数字、Ctrl+符号）。
    // 刻意做成兜底而不是白名单：漏一个键的后果是「按了什么都不发」（R3 的失效形态），
    // 而多兜一个的后果只是「VT 编码器决定不发」—— 与 xterm 现路径逐字节一致。
    // `!altKey` 是硬条件：Windows 的 AltGr = Ctrl+Alt，那是**产字符**的组合（€ 等），
    // 必须落 P7 给输入域；xterm 的编码器同样要求 `!ev.altKey` 才走 ctrl 分支。
    if (ev.ctrlKey && !ev.altKey) return decide('vt');
    // 非 mac：Alt+字符 = Meta 前缀（xterm 编码器在 `!isMac` 时发 ESC+char，
    // 也是 readline 的 M-b/M-f 语义）。浏览器在这些平台上也不会把 Alt 组合插进输入域，
    // 落 P7 就等于什么都不发。
    if (!ctx.isMac && ev.altKey && !ev.ctrlKey && isFieldBorne(ev)) return decide('vt');
    // 小键盘 + DECKPAM：应用小键盘模式下数字/运算符键发 SS3 序列而不是字面字符，
    // 交给输入域就会静默走成普通字符（golden 按键扫描会逐字节报差）。
    if (ev.location === 3 && ctx.modes.applicationKeypadMode) return decide('vt');

    // ── P7 ── 其余可打印键：**不 preventDefault**，交给输入域 → `input` → diff → PTY。
    // 死键（´+e=é）、mac 的 Option 字符、**不发 composition 事件的输入法**，
    // 只有输入域是唯一真相。走到这里时 metaKey 恒 false（P2 已返回）、
    // ctrlKey 只可能与 altKey 同时为真（AltGr）。
    if (isFieldBorne(ev)) return decide('text');

    // ── P8 ── 既不产字符也无 VT 语义：CapsLock、F13+、媒体键、其余具名键。
    return decide('ignore');
}

/**
 * ── 与 spec §C 的偏离清单（实现时发现的表内缺陷，需回流 spec）────────────
 * 1. **P6 在表里是死代码**：P5 的集合含 `Enter` 且优先级更高，barMode 的 Enter 永远
 *    到不了 P6。本实现把 P6 提到 P5 之前（并补上 Shift+Enter → 输入域换行，对齐
 *    `TermInputBar` 既有语义）。
 * 2. **P7 的判据与依据打架**：判据 `key.length === 1` 收不住死键（`key === 'Dead'`），
 *    而依据一行点名了死键。本实现按依据把 `Dead`/`Unidentified` 纳入 P7。
 * 3. **P4/P5 只写了 mac 的 Alt 语义**：非 mac 的 Alt+字符是 Meta 前缀（ESC+char），
 *    照表实现会落 P7 → 浏览器不产字符 → 这些平台上 M-b/M-f 全哑。本实现补了一条。
 * 4. **AltGr 未覆盖**：Windows 的 AltGr 上报为 `ctrlKey && altKey`，照 P5 的
 *    「Ctrl+字母」会被送去 VT，欧洲布局打不出 €/@ 等字符。本实现给 ctrl 兜底加了
 *    `!altKey` 硬条件（与 xterm 编码器同款）。
 * 5. **纯修饰键的次序**：P8 在表尾，但修饰键自身的 keydown 带着 `ctrlKey:true`，
 *    照表序会先命中 P5 的 ctrl 组合。本实现把修饰键判定提到 P5 之前。
 * 6. **`ctx.modes` 在表里没有任何一行用到**：`applicationCursorKeysMode` 在路由层
 *    确实用不上（方向键无条件归 VT，模式由编码器自己查），本实现保留字段以对齐
 *    spec 的签名；`applicationKeypadMode` 则被补成了一条真实规则（小键盘）。
 *    若 spec 确认不要小键盘规则，则 `ctx.modes` 应整体从签名里删掉。
 */
