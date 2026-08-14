/**
 * termInputModel —— 输入域 → PTY 的核心状态机（纯函数，spec §设计 E 的实现）
 *
 * spec: `specs/2026-08-terminal-input-ownership.md` §E「核心状态机」
 * Step 0：**只有状态机，没有接线**。零 DOM、零定时器（时间由宿主经 `tick`/`at` 注入）、
 * 零 import 副作用。桌面与移动端共用同一份核心，差异只是一个 `policy` 入参。
 *
 * ══ 铁律（本文件的全部意义）═══════════════════════════════════════════════
 *   **`emit` 只能由 `field-value` 的单调 diff 产生。**
 *   **`composing` 只用于决定「能否清空输入域」，绝不出现在任何决定是否 emit 的条件里。**
 *
 * 代码结构上这条是**显然成立**的，不靠自觉：
 *   - 全文件只有一处赋值 `emit`，就在 `field-value` 分支里，值恒为 `diffToPty(...)`；
 *     其他六类事件的分支根本没有产生 `emit` 的语句。
 *   - `state.composing` 只在两个地方被**读**：`canClearField()`（能不能清空）
 *     与它的两个调用点（`tick` 的 idle 清空、`clear-request`）。搜 `composing` 即可核对。
 *   - `composition-start` / `composition-end` **不产生任何字节**，它们只翻 `composing`。
 *
 * 推论（= spec §目标 2）：composition 事件的**缺失 / 重复 / 乱序**在数学上不可能吞掉
 * 或重复发送文本 —— 最坏后果只是「输入域清空被推迟」。这正是 IME 三次复发的病根
 * （xterm 用持久标志 `_isComposing` 当放行闸门，`compositionend` 一丢就永久吞键）被
 * 从结构上拆掉的地方。任何把 `composing` 写进 emit 判断的"优化"都会把 bug 请回来。
 *
 * ── 为什么输入域（field）是唯一真相 ─────────────────────────────────────
 * 移动端观测不到按键（软键盘每一击都是 keyCode 229），OS 键盘把输入域当作**它自己的
 * 模型**（光标前有什么）。我们只镜像「观测到的输入域内容变化」，绝不背着键盘改它 ——
 * v1 移动桥每次发送后清空输入域，键盘于是认为字段已空、不再发退格事件，而 PTY 里还
 * 留着字母：这就是"删不掉的最后一个字母"。桌面相反：硬件键盘不镜像字段内容，残字会
 * 无界增长且让 overlay 宽度策略失准，所以桌面**要**在空闲时清空 —— 这就是两套 policy。
 */

/**
 * END-RELATIVE edit diff between two field values, expressed as what a terminal
 * cursor at end-of-line can actually perform: delete everything after the common
 * PREFIX (as a CODE POINT count — one `\x7f` erases one code point on the pty
 * side), then retype the rest. Deliberately NO common-suffix preservation:
 * "helo "→"hello " must become "delete 2, type 'lo '", not an impossible
 * mid-string insert. End-of-line edits (the 99% case: typing, backspace,
 * autocorrect replacing the last word) are minimal.
 *
 * 迁移说明：这两个函数原先住在 `mobileInputBridge.ts`，Step 0 抽到这里共用；
 * `mobileInputBridge` 改为 import 并原样 re-export，行为与既有测试一字不变。
 */
export function diffTextValue(prev: string, next: string): { deletes: number; insert: string } {
    if (prev === next) return { deletes: 0, insert: '' };
    const minLen = Math.min(prev.length, next.length);
    let p = 0;
    while (p < minLen && prev.charCodeAt(p) === next.charCodeAt(p)) p++;
    // Don't split a surrogate pair at the prefix boundary.
    if (p > 0 && p < prev.length && p < next.length) {
        const c = prev.charCodeAt(p - 1);
        if (c >= 0xd800 && c <= 0xdbff) p--;
    }
    const removed = prev.slice(p);
    const insert = next.slice(p);
    return { deletes: [...removed].length, insert };
}

/** Normalize field-borne text for the pty: newlines become CR. */
export function toPtyText(insert: string): string {
    return insert.replace(/\r?\n/g, '\r');
}

/** 单调 diff → PTY 字节。**`emit` 的唯一生产者。** */
function diffToPty(prev: string, next: string): string {
    const { deletes, insert } = diffTextValue(prev, next);
    return '\x7f'.repeat(deletes) + toPtyText(insert);
}

/** 字段策略：spec §E 第 3 条，两端唯一的分叉，且只是一个入参。 */
export type FieldPolicyMode =
    /** 桌面：空闲即清空（硬件键盘不镜像字段内容，清了不会让键盘失忆）。 */
    | 'clear-on-idle'
    /** 移动：绝不主动清（软键盘把字段当自己的模型），只在自然边界清。 */
    | 'sticky';

export interface FieldPolicy {
    mode: FieldPolicyMode;
    /** `clear-on-idle`：距上次提交多久算空闲。300ms 是给多阶段 IME 留的保守值。 */
    clearIdleMs: number;
    /** `sticky`：超过这个长度且落在自然边界（行尾/空白）才允许清空，防无界增长。 */
    maxLen: number;
}

export const DEFAULT_FIELD_POLICY: Readonly<Record<FieldPolicyMode, FieldPolicy>> = {
    'clear-on-idle': { mode: 'clear-on-idle', clearIdleMs: 300, maxLen: 400 },
    sticky: { mode: 'sticky', clearIdleMs: 0, maxLen: 400 },
};

export interface TermInputState {
    /** 已经镜像进 PTY 的输入域内容。diff 的基准，**唯一**决定 emit。 */
    shadow: string;
    /** 是否在合成中。**只用于「能否清空输入域」**，见文件头铁律。 */
    composing: boolean;
    /** 最近一次 shadow 变化的时刻（宿主注入的毫秒）。只服务于 idle 清空。 */
    lastCommitAt: number;
    policy: FieldPolicy;
}

export type TermInputEvent =
    /** 观测到输入域的当前内容（`input` / composition 结算后的读数）。**唯一发字节的事件。** */
    | { type: 'field-value'; value: string; at: number }
    | { type: 'composition-start' }
    | { type: 'composition-end' }
    /** 输入元素失焦：在途合成按中止处理（迟到的 end 不得重复发送，它本来也不发）。 */
    | { type: 'blur' }
    | { type: 'focus' }
    /** 外部改动输入域（宿主自己写了值 / 清空后回读）：只对齐 shadow，**不发送**。 */
    | { type: 'adopt'; value: string }
    /** 时钟。时间由宿主注入，本模块零定时器。 */
    | { type: 'tick'; now: number }
    /** 宿主显式请求清空输入域（模式切换、发送整行之后等）。 */
    | { type: 'clear-request' };

export interface ReduceResult {
    state: TermInputState;
    /** 要写进 PTY 的字节。空串 = 什么都不发。 */
    emit: string;
    /**
     * 宿主应当把输入域清空（并保持 shadow 已归零）。
     *
     * spec §E 的返回类型只有 `{state, emit}`，但「清空输入域」是一个**动作**，纯函数
     * 只能把它作为结果返回、不能自己去做（也不能让宿主靠 diff 两个 state 猜）。
     * 清空**永远不发字节**（spec 病理表「清空不发送」那一行），所以它和 `emit` 是
     * 两条互不相干的通道。
     */
    clearField: boolean;
}

export function initialState(policy: FieldPolicyMode | FieldPolicy): TermInputState {
    const p = typeof policy === 'string' ? DEFAULT_FIELD_POLICY[policy] : policy;
    return { shadow: '', composing: false, lastCommitAt: 0, policy: { ...p } };
}

/** 结果构造器：没写 `emit` 的分支恒为 `''` —— 铁律在类型层面的兜底。 */
function result(state: TermInputState, emit = '', clearField = false): ReduceResult {
    return { state, emit, clearField };
}

/**
 * 唯一读 `composing` 的地方：**能不能清空输入域**。
 * 合成期间清空会把在途 preedit 连同 IME 的内部状态一起打断（round 2 的
 * "heal 写 textarea 反而制造卡死"就是这个错误的第一次发生）。
 */
function canClearField(state: TermInputState): boolean {
    return !state.composing;
}

/** 自然边界：行尾/空白处清空，键盘的上下文本来就要重开，清了不会失忆。 */
function atNaturalBoundary(value: string): boolean {
    return /[\n\s]$/.test(value);
}

/**
 * `reduce(state, ev) → { state, emit, clearField }`
 *
 * 纯函数：不改动入参（state 一律返回新对象），不读时钟、不碰 DOM。
 * 幂等：同值的 `field-value` 重复投递恒 emit `''`（diff 基准是 shadow）。
 */
export function reduce(state: TermInputState, ev: TermInputEvent): ReduceResult {
    switch (ev.type) {
        case 'field-value': {
            // ── emit 的唯一生产点 ──────────────────────────────────────────
            // 注意这里**没有**任何 `composing` 判断：合成中、合成后、compositionend
            // 从未到达、连续两个 start —— 一律走同一条单调 diff。事件缺失不可能吞字节。
            const emit = diffToPty(state.shadow, ev.value);
            if (emit === '') {
                // 值没变（幂等重投）：连 lastCommitAt 都不动，免得 idle 清空被无限推迟。
                return result(state);
            }
            let next: TermInputState = { ...state, shadow: ev.value, lastCommitAt: ev.at };
            // sticky：绝不主动清，只在自然边界且超长时收一次，防止残字无界增长。
            if (next.policy.mode === 'sticky'
                && canClearField(next)
                && ev.value.length > next.policy.maxLen
                && atNaturalBoundary(ev.value)) {
                next = { ...next, shadow: '' };
                return result(next, emit, true);
            }
            return result(next, emit);
        }

        case 'composition-start':
            // 只翻标志。**不发字节**，也不需要「先 sync 一下」—— 输入域内容变化一律
            // 由 `field-value` 送达，diff 的基准是 shadow 而不是"合成开始时的快照"
            // （xterm 的 `_compositionPosition.start` 正是那种快照，Gboard 重组合时
            // 算出空子串 ⇒ 退格全被吞掉）。
            return result({ ...state, composing: true });

        case 'composition-end':
            // 同样**不发字节**：提交内容会以 `field-value` 的形式到来（可能在这之前、
            // 之后，或者这个事件根本不来）。三种情况的 emit 完全一样。
            return result({ ...state, composing: false });

        case 'blur':
            // 在途合成按中止处理：失焦后 IME 不会再给我们 `compositionend`（这正是
            // "切输入法就打不了中文"的现场）。已敲的内容早已由 `field-value` 提交过，
            // 这里放开 composing 只是让清空重新可用。迟到的 end 落到上面的分支，
            // 依然一个字节都不发。
            return result({ ...state, composing: false });

        case 'focus':
            return result(state);

        case 'adopt':
            // 外部改动：对齐基准，**不发送**（spec 病理表「清空不发送」的通用形态）。
            return result({ ...state, shadow: ev.value });

        case 'tick': {
            // 桌面 idle 清空。`composing` 在这里出现 —— 这是它被允许出现的**唯一**语境。
            if (state.policy.mode !== 'clear-on-idle') return result(state);
            if (!canClearField(state)) return result(state);
            if (state.shadow === '') return result(state);
            if (ev.now - state.lastCommitAt <= state.policy.clearIdleMs) return result(state);
            return result({ ...state, shadow: '' }, '', true);
        }

        case 'clear-request':
            // 合成期拒绝清空（会打断在途 preedit）；宿主可以稍后再请求或等 idle。
            if (!canClearField(state)) return result(state);
            return result({ ...state, shadow: '' }, '', true);
    }
}

/** 顺序 fold，便于测试与宿主批量回放。emit 按顺序拼接。 */
export function reduceAll(
    state: TermInputState,
    events: readonly TermInputEvent[],
): { state: TermInputState; emit: string; clears: number } {
    let cur = state;
    let emit = '';
    let clears = 0;
    for (const ev of events) {
        const r = reduce(cur, ev);
        cur = r.state;
        emit += r.emit;
        if (r.clearField) clears++;
    }
    return { state: cur, emit, clears };
}
