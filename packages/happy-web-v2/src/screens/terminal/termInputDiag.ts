/**
 * termInputDiag —— `window.__vhTermInput` 的**差分断言面**（spec §可测试性）
 *
 * spec: `specs/2026-08-terminal-input-ownership.md`「按键扫描（golden，Step 1 的护栏）」
 *
 * ── 为什么和 `termDiag.ts` 分成两个模块 ──────────────────────────────────
 * `termDiag` 的纪律是**永不保留击键原文**（终端里会敲密码/token）。而 golden 按键
 * 扫描的整个价值就在于「`?input=xterm` 与 `?input=own` 两条路径写进 PTY 的字节
 * **逐字节一致**」——它必须拿到原文才能比对。这是一条**刻意的、有代价的例外**，
 * 所以单独一个模块、单独一个全局键，绝不和 `__vhTermDiag` 的元数据缓冲混在一起：
 *  - 默认**只在 `debugMode` 或 dev 构建**下挂载（生产默认根本没有这个全局）；
 *  - 环形缓冲上限 200 条（spec 定值），关掉即清空；
 *  - 它是**只读**的：没有任何可以从控制台改变输入路径行为的入口。
 *
 * ── 契约（golden 差分工具依赖，不要改形状）──────────────────────────────
 *   window.__vhTermInput = {
 *     ownership: 'xterm' | 'own',   // 当前生效路径（差分脚本据此标注两轮）
 *     routed:  [...],               // 每次 keydown 的路由判定（own 路径才有）
 *     emitted: [...],               // **实际写入 PTY 的字符串**（两条路径都有）
 *     clear(), snapshot()
 *   }
 * `emitted` 记的是 `sendInput` 的入参 —— 那是本仓唯一的写 PTY 出口，所以无论
 * 字节来自 xterm 的编码器、输入域 diff、粘贴、预设还是键盘条，都在同一个序列里。
 *
 * ⚠️ **`routed` / `emitted` 必须返回活的数组本身，不能返回拷贝。**
 * `scripts/probe/term-input-goldendiff.mjs` 每个用例之间是靠
 * `window.__vhTermInput.emitted.length = 0` 清缓冲的（它把结果 try/catch 成
 * "清成功了"）。返回拷贝的话清空是**静默的 no-op**：142 个用例会一路累积，
 * 比出来的"逐字节一致"毫无意义 —— 正是这套工具存在的意义（反假绿）被自宫。
 * 所以这里用一个**原地**收尾的缓冲（`splice`，不是 `slice` 重新赋值），
 * 数组对象身份恒定，外部清空之后后续 push 仍然落进同一个数组。
 */
import type { KeyEventLike, RouteDecision, RouteKind } from './termInputRoute';

export interface TermInputRoutedEntry {
    at: number;
    key: string;
    code: string;
    keyCode?: number;
    /** 修饰键位串，形如 `"c-s-"`（ctrl/shift）；空串 = 无修饰。 */
    mods: string;
    isComposing: boolean;
    defaultPrevented: boolean;
    kind: RouteKind;
    preventDefault: boolean;
}

export interface TermInputEmittedEntry {
    at: number;
    /** 实际写入 PTY 的字符串（原文，见文件头的例外说明）。 */
    data: string;
}

export interface TermInputDiagHandle {
    noteRouted(ev: KeyEventLike, decision: RouteDecision): void;
    noteEmitted(data: string): void;
    dispose(): void;
}

const GLOBAL_KEY = '__vhTermInput';

/**
 * 定长缓冲，**原地**收尾（见文件头：数组身份必须恒定，外部 `length = 0` 要真的清）。
 * 与 `termDiag.createRingBuffer` 的区别只在这一点上 —— 那个刻意返回拷贝
 * （只读诊断面，不许从控制台改），这个刻意暴露活数组（差分工具要清它）。
 */
export function createLiveBuffer<T>(capacity: number): { readonly arr: T[]; push(v: T): void } {
    const cap = Math.max(1, Math.floor(capacity));
    const arr: T[] = [];
    return {
        arr,
        push(v: T) {
            arr.push(v);
            if (arr.length > cap) arr.splice(0, arr.length - cap);
        },
    };
}

/** 修饰键位串：稳定顺序，方便 golden 比对时肉眼读。 */
export function modString(ev: {
    ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean;
}): string {
    return (ev.ctrlKey ? 'c-' : '') + (ev.altKey ? 'a-' : '')
        + (ev.shiftKey ? 's-' : '') + (ev.metaKey ? 'm-' : '');
}

export function classifyRouted(
    ev: KeyEventLike,
    decision: RouteDecision,
    at: number,
): TermInputRoutedEntry {
    return {
        at,
        key: ev.key,
        code: ev.code,
        keyCode: ev.keyCode,
        mods: modString(ev),
        isComposing: ev.isComposing === true,
        defaultPrevented: ev.defaultPrevented === true,
        kind: decision.kind,
        preventDefault: decision.preventDefault,
    };
}

export function installTermInputDiag(opts: {
    enabled: boolean;
    ownership: string;
    ringSize?: number;
    now?: () => number;
}): TermInputDiagHandle {
    // `globalThis` 而不是 `window`：浏览器里是同一个对象（控制台仍然打
    // `window.__vhTermInput`），同时让本模块在 node 测试环境里可安装、可测。
    const host = typeof globalThis === 'undefined'
        ? null
        : (globalThis as unknown as Record<string, unknown>);
    if (!opts.enabled || !host) {
        return { noteRouted() {}, noteEmitted() {}, dispose() {} };
    }
    const now = opts.now ?? (() => Date.now());
    const cap = opts.ringSize ?? 200;
    const routed = createLiveBuffer<TermInputRoutedEntry>(cap);
    const emitted = createLiveBuffer<TermInputEmittedEntry>(cap);

    const api = Object.freeze({
        ownership: opts.ownership,
        // 活数组（不是拷贝）—— 见文件头的 ⚠️。
        get routed() { return routed.arr; },
        get emitted() { return emitted.arr; },
        /** 差分脚本每个场景开跑前调一次（它也可能直接写 `emitted.length = 0`）。 */
        clear() { routed.arr.length = 0; emitted.arr.length = 0; },
        /** `copy(window.__vhTermInput.snapshot())` 一把带走（这个才是拷贝）。 */
        snapshot() {
            return Object.freeze({
                ownership: opts.ownership,
                routed: routed.arr.slice(),
                emitted: emitted.arr.slice(),
            });
        },
    });
    host[GLOBAL_KEY] = api;

    return {
        noteRouted(ev, decision) { routed.push(classifyRouted(ev, decision, now())); },
        noteEmitted(data) { emitted.push({ at: now(), data }); },
        dispose() {
            // 只摘自己挂的那一个（StrictMode 双挂时后挂的必须活下来）。
            if (host[GLOBAL_KEY] === api) delete host[GLOBAL_KEY];
        },
    };
}
