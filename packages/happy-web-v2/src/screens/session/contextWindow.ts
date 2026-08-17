/**
 * 按真实模型 id 推断上下文窗口大小（B-135）。
 *
 * 为什么需要：`format.ts` 原来把窗口写死成 190k。Owner 日常跑 opus 的 1M 变体——
 * 到 190k 就显示「剩余 0%」并钉死在那，实际还有 80% 可用。分母必须跟着模型走。
 *
 * 为什么按「id 里的标记」而不是查表：模型 id 会不断新增（claude-opus-5 / 4.8 /
 * sonnet-4.6 / haiku-4.5 …），硬编码表每出一个新模型就静默失准一次，而失准的表现
 * 恰恰是「百分比看着正常但是错的」——最坏的一类 bug。1M 变体在 id 里一律带
 * `1m` 标记，据此判断比维护清单稳。
 *
 * ⚠️ 拿不到模型时**不猜**：返回 null，调用方显示 token 绝对数而不是一个可能错的
 * 百分比。`modelMode='default'` 且还没收到任何 assistant 消息时就是这种情况。
 */

/** 标准 Claude 上下文窗口（非 1M 变体）。 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** 1M 变体的窗口。 */
export const LONG_CONTEXT_WINDOW = 1_000_000;

/**
 * 可用于计算百分比的上下文窗口；模型未知时返回 null（调用方据此降级为只显示 token 数）。
 *
 * 识别的 1M 标记（大小写不敏感）：`[1m]`、`-1m`、`_1m`、`:1m`、以及结尾的 `1m`。
 * 刻意不匹配裸 `1m` 子串——`claude-x1m-…` 这种假阳性比漏判更糟。
 */
export function contextWindowFor(model: string | null | undefined): number | null {
    if (!model || typeof model !== 'string') return null;
    const id = model.trim().toLowerCase();
    if (!id) return null;
    return /(\[1m\]|[-_:]1m\b|[-_:]1m$)/.test(id) ? LONG_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW;
}

/**
 * 已用百分比（0..100，clamp）。窗口未知时返回 null——调用方不要退回一个写死的分母，
 * 那正是 B-135 的成因。
 */
export function contextPercentOf(contextSize: number, window: number | null): number | null {
    if (window === null || !(window > 0)) return null;
    if (!(contextSize > 0)) return 0;
    return Math.max(0, Math.min(100, Math.round((contextSize / window) * 100)));
}
