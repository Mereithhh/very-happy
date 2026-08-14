/**
 * 终端输入路径的诊断钩子 —— `window.__vhTermDiag`。
 *
 * 为什么值得一个模块：中文输入法失效复发了三次，**其中至少一次的排查代价是
 * 因为线上问不到状态**（imeStuckGuard 的 counters 关在闭包里，焦点归属没有任何
 * 可读快照，只能靠 CDP 现场复现）。这个钩子把"当场能问出真相"的四个量做成
 * 只读快照：焦点在谁手里、有没有浮层、是否正在合成、守卫/看门狗的计数器。
 *
 * 纪律：
 *  - **只读**。所有字段是 getter，返回的 `snapshot()` 是 frozen 的普通对象；
 *    没有任何可以从控制台改变输入路径行为的入口（唯一的开关是关掉 onData 采样）。
 *  - **默认只在 `debugMode`（或 dev 构建）挂载**，生产默认没有这个全局。
 *  - **onData 环形缓冲只记元数据，不记原文**：终端里会敲密码/token，把击键原文
 *    留在一个全局对象上是不可接受的代价。诊断真正需要的问题是"字节到底有没有
 *    进 PTY / 是不是 CJK / 是不是控制字符"，`{at,len,cjk,ctrl}` 足以回答（"英文进了
 *    中文没进"、"一个 onData 都没发"这两种病象都能区分）。缓冲可一键关掉。
 */

export interface TermDiagOnDataEntry {
    /** Date.now() */
    at: number;
    /** 字节串长度（UTF-16 code unit 数，够用来区分"空/一个键/一段粘贴"）。 */
    len: number;
    /** 含 CJK 字符（诊断"中文哑英文正常"的关键位）。 */
    cjk: boolean;
    /** 含 C0 控制字符（\r、\x1b[A、Ctrl-C…）。 */
    ctrl: boolean;
}

export interface TermDiagGuardCounters {
    /** imeStuckGuard：heal / 残字清理次数。 */
    heals: number;
    residueClears: number;
    /** 焦点看门狗计数器。 */
    focusChecks: number;
    focusRestores: number;
    focusSkippedOverlay: number;
    focusSkippedComposing: number;
}

export interface TermDiagSnapshot {
    /** 'terminal' | 'other' | 'nobody' —— 'nobody' 就是本次事故的病态。 */
    focusOwner: string;
    hasOverlay: boolean;
    composing: boolean;
    guardCounters: TermDiagGuardCounters;
    /** 最近一次焦点归还的时间戳（0 = 从未）。 */
    lastRestoreAt: number;
    /** 最近 ≤50 条写入 PTY 的元数据（默认只在 debugMode 采样）。 */
    recentOnData: TermDiagOnDataEntry[];
    /** onData 采样当前是否开着。 */
    onDataCapture: boolean;
}

/** 定长环形缓冲（纯，单测）。 */
export function createRingBuffer<T>(capacity: number) {
    const cap = Math.max(1, Math.floor(capacity));
    let buf: T[] = [];
    return {
        push(v: T): void {
            buf.push(v);
            if (buf.length > cap) buf = buf.slice(buf.length - cap);
        },
        toArray(): T[] {
            return buf.slice();
        },
        clear(): void {
            buf = [];
        },
        get size(): number {
            return buf.length;
        },
        get capacity(): number {
            return cap;
        },
    };
}

// CJK 统一表意文字 + 扩展 A + 兼容表意 + 假名 + 谚文 + 全角标点；只用于诊断
// 分类，宽松即可。用数字码点而不是正则字面量，是为了让本文件里不出现任何
// 非 ASCII 字符类或字面控制字符（可读性 + 免踩编码坑）。
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
    [0x1100, 0x11ff], // Hangul Jamo
    [0x2e80, 0x2fdf], // CJK radicals / Kangxi
    [0x3000, 0x303f], // CJK symbols and punctuation
    [0x3040, 0x30ff], // Hiragana + Katakana
    [0x3130, 0x318f], // Hangul compatibility Jamo
    [0x3400, 0x4dbf], // CJK ext A
    [0x4e00, 0x9fff], // CJK unified ideographs
    [0xa960, 0xa97f], // Hangul Jamo ext A
    [0xac00, 0xd7af], // Hangul syllables
    [0xf900, 0xfaff], // CJK compatibility ideographs
    [0xfe30, 0xfe4f], // CJK compatibility forms
    [0xff00, 0xffef], // Halfwidth / fullwidth forms
];

function hasCjk(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        for (const [lo, hi] of CJK_RANGES) if (c >= lo && c <= hi) return true;
    }
    return false;
}

function hasControl(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x20 || c === 0x7f) return true;
    }
    return false;
}

/** 把一次 PTY 写入分类成元数据（纯，绝不保留原文）。 */
export function classifyOnData(d: string, at: number): TermDiagOnDataEntry {
    return { at, len: d.length, cjk: hasCjk(d), ctrl: hasControl(d) };
}

export interface TermDiagHandle {
    /** 每次写 PTY 调一次（只在采样开着时才记）。 */
    noteOnData(d: string): void;
    dispose(): void;
}

const GLOBAL_KEY = '__vhTermDiag';

/**
 * 挂载诊断钩子。`enabled: false` 时返回一个零成本的空壳（生产默认路径：
 * `noteOnData` 是个空函数，不建缓冲、不挂全局）。
 */
export function installTermDiag(opts: {
    enabled: boolean;
    /** 默认跟随 enabled；可单独关掉 onData 采样。 */
    captureOnData?: boolean;
    read: () => Omit<TermDiagSnapshot, 'recentOnData' | 'onDataCapture'>;
    now?: () => number;
    ringSize?: number;
}): TermDiagHandle {
    // `globalThis`, not `window`: identical object in the browser (so
    // `window.__vhTermDiag` is what you type in the console) and it also makes
    // this installable — hence testable — in the node test environment.
    const host = typeof globalThis === 'undefined' ? null : (globalThis as unknown as Record<string, unknown>);
    if (!opts.enabled || !host) {
        return { noteOnData() {}, dispose() {} };
    }
    const now = opts.now ?? (() => Date.now());
    const ring = createRingBuffer<TermDiagOnDataEntry>(opts.ringSize ?? 50);
    let capture = opts.captureOnData ?? true;

    const snapshot = (): TermDiagSnapshot => {
        const base = opts.read();
        return Object.freeze({
            ...base,
            guardCounters: Object.freeze({ ...base.guardCounters }),
            recentOnData: ring.toArray(),
            onDataCapture: capture,
        }) as TermDiagSnapshot;
    };

    const api = Object.freeze({
        get focusOwner() { return opts.read().focusOwner; },
        get hasOverlay() { return opts.read().hasOverlay; },
        get composing() { return opts.read().composing; },
        get guardCounters() { return Object.freeze({ ...opts.read().guardCounters }); },
        get lastRestoreAt() { return opts.read().lastRestoreAt; },
        get recentOnData() { return ring.toArray(); },
        get onDataCapture() { return capture; },
        /** 完整只读快照（`copy(window.__vhTermDiag.snapshot())` 一把带走）。 */
        snapshot,
        /** 关/开 onData 元数据采样（关掉同时清空已采的）。 */
        setOnDataCapture(on: boolean) {
            capture = !!on;
            if (!capture) ring.clear();
            return capture;
        },
        clearOnData() { ring.clear(); },
    });

    host[GLOBAL_KEY] = api;

    return {
        noteOnData(d: string) {
            if (!capture) return;
            ring.push(classifyOnData(d, now()));
        },
        dispose() {
            // 只摘自己挂的那一个（终端屏理论上是单例，但 StrictMode 双挂时
            // 后挂的那个必须活下来）。
            if (host[GLOBAL_KEY] === api) delete host[GLOBAL_KEY];
        },
    };
}
