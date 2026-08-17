/**
 * claude 自报进度的节流与「水位」（B-132）。
 *
 * 背景：看板进度原来是 `boardAnalyzer` 拿 `claude -p --model haiku` 起子进程去**猜**
 * 当前会话在干嘛。让 claude 自己汇报比外部 LLM 猜准得多、实时得多、且免费。
 * 所以自报优先，boardAnalyzer 退化成「没自报时的兜底」。
 *
 * ⚠️ 为什么是内存状态而不是文件：`startHappyServer` 与 `BoardAnalyzer` 都在**同一个
 * session 进程**里创建（见 `runClaude.ts`），所以「本会话最近自报于何时」是进程内事实。
 * 别照抄 `boardAnalyzer.ts` 的 `FileRateLimiter` —— 那个落文件是因为它是**跨会话的
 * 机器级**配额（每个 session 一个进程，计数器必须共享）。两件事不同，混淆会白白引入
 * 一个文件读写和一堆竞态。（backlog B-132 初稿把这条写错过。）
 */

/** 两次自报之间的最小间隔：防 claude 把它当 log 逐步骤刷。 */
export const SELF_REPORT_MIN_INTERVAL_MS = 30 * 1000;

/**
 * 自报的「新鲜期」：这段时间内有过自报，boardAnalyzer 就不必再花钱猜。
 * 取 15min 而不是等于 analyzer 的 5min 最小间隔——自报是更可信的信息源，
 * 应该压制掉数次 analyzer 轮次，而不是只压一次。
 */
export const SELF_REPORT_FRESH_MS = 15 * 60 * 1000;

export type BoardAttention = 'none' | 'review' | 'blocked';

const ATTENTION_VALUES: readonly BoardAttention[] = ['none', 'review', 'blocked'];

/** 进度文案的字符上限——它渲染在看板卡片的一行里。 */
export const PROGRESS_MAX_CHARS = 200;

export interface SelfReportState {
    /** 上一次被**接受**的自报时刻；0 = 从未。注意是「接受」不是「收到」——
     *  被节流掉的调用不推进水位，否则 claude 疯狂刷就能把水位一直顶住。 */
    lastAcceptedAt: number;
}

export function createSelfReportState(): SelfReportState {
    return { lastAcceptedAt: 0 };
}

/** 这次自报该不该接受（节流）。首次总是接受。 */
export function shouldAcceptSelfReport(state: SelfReportState, now: number): boolean {
    if (state.lastAcceptedAt === 0) return true;
    return now - state.lastAcceptedAt >= SELF_REPORT_MIN_INTERVAL_MS;
}

/** 最近是否有过自报——boardAnalyzer 据此跳过一次花钱的分析。 */
export function isSelfReportFresh(state: SelfReportState, now: number): boolean {
    if (state.lastAcceptedAt === 0) return false;
    // 时钟回跳（NTP 校正 / 手动改表）时不要把未来的水位当成新鲜，否则 analyzer
    // 可能被永久压制。只认「过去 SELF_REPORT_FRESH_MS 之内」。
    const age = now - state.lastAcceptedAt;
    return age >= 0 && age < SELF_REPORT_FRESH_MS;
}

/** 规范化 attention；无法识别一律当 'none'（宁可少报警，不要凭错值弹红点）。 */
export function normalizeAttention(value: unknown): BoardAttention {
    return ATTENTION_VALUES.includes(value as BoardAttention) ? (value as BoardAttention) : 'none';
}

/** 规范化进度文案：压成单行、去首尾空白、截断。空串返回 null（不写 metadata）。 */
export function normalizeProgress(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const flat = value.replace(/\s+/g, ' ').trim();
    if (!flat) return null;
    return flat.length > PROGRESS_MAX_CHARS ? flat.slice(0, PROGRESS_MAX_CHARS) : flat;
}
