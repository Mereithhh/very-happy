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
 */
import type { KeyEventLike, RouteDecision, RouteKind } from './termInputRoute';
import { createRingBuffer } from './termDiag';

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
    const routed = createRingBuffer<TermInputRoutedEntry>(cap);
    const emitted = createRingBuffer<TermInputEmittedEntry>(cap);

    const api = Object.freeze({
        ownership: opts.ownership,
        get routed() { return routed.toArray(); },
        get emitted() { return emitted.toArray(); },
        /** 差分脚本每个场景开跑前调一次。 */
        clear() { routed.clear(); emitted.clear(); },
        /** `copy(window.__vhTermInput.snapshot())` 一把带走。 */
        snapshot() {
            return Object.freeze({
                ownership: opts.ownership,
                routed: routed.toArray(),
                emitted: emitted.toArray(),
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
