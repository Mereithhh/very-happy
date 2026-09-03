/**
 * outputCoalescer —— 把窗格的碎写合并成「每显示帧一帧」，**在拿 seq 之前** (B-334)。
 *
 * ## 为什么需要它（实测，2026-09-03，隔离 socket，151x51）
 *
 * tmux 控制模式的 `%output` 是「产出方每 write 一次就发一条」，不做任何合并：
 *
 *     pi 0.84.4 启动首帧   1029 块 / 11.8 KB / 中位 9 B / 最大 18 B / 跨 712ms
 *     seq 1 3000（行缓冲） 2236 块 / 16.9 KB / 中位 6 B
 *     cat 同样大的文件     70 块 / 17.0 KB / 中位 1024 B（块缓冲，对照组）
 *
 * daemon 过去对每一块各做一次 `ingest`（base64）→ ring 入一条 → `encrypt` →
 * 再 base64 → **同时**往 socket 和 relaySocket 各 emit 一次。9 字节的负载配上
 * nonce/MAC/`terminalId`/`seq`/socket.io 封装，一帧要 130–160 字节：放大约 15 倍，
 * 而且是**上千条独立消息**排队过 relay，再到 web 侧各走一次 seq 判定、一次
 * `outChain.then()` 和一次 `term.write()`。源头 712ms 的一帧到浏览器就摊成了肉眼
 * 可见的逐行绘制——Owner 报的「启动 pi/claude code 时没有输入框、或者输入框只画了
 * 一半」就是这个中间态。
 *
 * ## 合并点为什么必须在 `ingest()` 之前
 *
 * 合并后的字节和逐块拼接**逐字节相同**（这是本模块唯一的正确性契约），所以在
 * `ingest()` 之前合并等价于「tmux 这次读到的就是这么大一块」：一个 seq 覆盖合并后的
 * 全部字节，ring / replay / gap 判定全是 seq 连续性，一个字都不用改，web 侧和线上协议
 * 零改动（对老 web 也天然兼容，铁律 4/14）。
 * 反过来在 emit 层合并已经编号的块，就得在线上表达「一帧多个 seq」——新事件 + 能力协商，
 * 而且省不掉每块一次的加密。
 *
 * ## 为什么是 Nagle 式「首块立即发」而不是固定节流
 *
 * 交互回显（一次按键、一个光标闪烁）几乎总是「空闲后的第一块」：只要距上次发出已经
 * 超过一个窗口，就**零延迟直接发**，打字手感一点不变。只有真正的突发（TUI 首帧）才会
 * 落进缓冲，此后最多每 `maxDelayMs` 发一帧。**永远只合并、绝不丢弃或重排**——字节流
 * 是有状态的（转义序列跨块），丢一块就毁掉它之后的一切。
 *
 * 纯函数模块（无计时器、无 `Date.now()`、无 I/O）：时间由调用方喂进来，副作用由
 * `TerminalSession` 负责。仓库对并行开发下的测试稳定性一贯这么要求
 * （`termWriteHold` / `termStreamSync` / `boardTaskOps` 先例）。
 */

export interface OutputCoalescerOptions {
    /** 一个字节最多能等多久。默认一个 60Hz 帧。 */
    maxDelayMs: number;
    /** 缓冲到这么多字节就提前吐出去，别让一次突发攒成一个巨帧。 */
    maxBytes: number;
}

export interface OutputCoalescer {
    /**
     * 喂一块 `%output`。返回**现在就该 ingest 的字节**，或 null 表示已缓冲
     * （调用方随后要按 `dueAt()` 布一个定时器）。
     */
    push(data: Buffer, now: number): Buffer | null;
    /** 立刻排空缓冲。没有缓冲则返回 null。 */
    flush(now: number): Buffer | null;
    /** 缓冲必须被 flush 的时刻（epoch ms）；没有缓冲则 null。 */
    dueAt(): number | null;
    /** 当前缓冲字节数（0 = 无待发）。 */
    pendingBytes(): number;
}

/** 一个 60Hz 帧：合并窗口的上限就是「人眼看不出来」的上限。 */
export const OUTPUT_COALESCE_MS = 16;
/** 单帧字节上限；tmux 自己一次读也就是这个量级。 */
export const OUTPUT_COALESCE_MAX_BYTES = 64 * 1024;

export function createOutputCoalescer(
    { maxDelayMs, maxBytes }: OutputCoalescerOptions = {
        maxDelayMs: OUTPUT_COALESCE_MS,
        maxBytes: OUTPUT_COALESCE_MAX_BYTES,
    },
): OutputCoalescer {
    let buffered: Buffer[] = [];
    let bufferedBytes = 0;
    let firstBufferedAt = 0;
    // 负无穷 ⇒ 第一块永远走「立即发」这条路，不用给 push 加特判。
    let lastEmitAt = Number.NEGATIVE_INFINITY;

    const drain = (now: number): Buffer | null => {
        if (bufferedBytes === 0) return null;
        const out = buffered.length === 1 ? buffered[0] : Buffer.concat(buffered, bufferedBytes);
        buffered = [];
        bufferedBytes = 0;
        firstBufferedAt = 0;
        lastEmitAt = now;
        return out;
    };

    return {
        push(data, now) {
            // 空块不许拿 seq：ingest 会把它记成一条 ring 条目和一次广播。
            if (data.length === 0) return null;
            // 空闲后的第一块：零延迟。交互回显走的就是这条。
            if (bufferedBytes === 0 && now - lastEmitAt >= maxDelayMs) {
                lastEmitAt = now;
                return data;
            }
            if (bufferedBytes === 0) firstBufferedAt = now;
            buffered.push(data);
            bufferedBytes += data.length;
            return bufferedBytes >= maxBytes ? drain(now) : null;
        },
        flush(now) {
            return drain(now);
        },
        dueAt() {
            // 截止时间挂在**最早**那一块上，所以任何一个字节的等待都不超过一个窗口
            // （挂在 lastEmitAt 上会让突发里晚到的块被前一块的窗口顺延）。
            return bufferedBytes === 0 ? null : firstBufferedAt + maxDelayMs;
        },
        pendingBytes() {
            return bufferedBytes;
        },
    };
}
