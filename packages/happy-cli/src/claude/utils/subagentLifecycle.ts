/**
 * B-260-P2 pure helpers for the sub-agent lifecycle mapping (no I/O).
 *
 * Facts these encode (SDK 0.3.232, measured on 797 real notifications):
 *  - background Agent tool_result is a stub; `tool_use_result.status ===
 *    'async_launched'` is the reliable marker;
 *  - the completion report lives in the task-notification USER message's
 *    <result> block (p50 3.3KB / p90 12KB / p99 29KB) — `summary` is one line;
 *  - a notification may carry a `[harness: …]` preamble and a <usage> block
 *    that are not part of the report.
 */

export const SUBAGENT_RESULT_MAX_CHARS = 16_384;
export const SUBAGENT_PROGRESS_MIN_INTERVAL_MS = 5_000;

export type SubagentResult = { text: string; truncated?: boolean };

export function capSubagentText(text: string, max = SUBAGENT_RESULT_MAX_CHARS): SubagentResult {
    const trimmed = text.trim();
    if (trimmed.length <= max) return { text: trimmed };
    return { text: trimmed.slice(0, max), truncated: true };
}

/** Text of a foreground Agent/Task `tool_use_result` (AgentOutput.content). */
export function toolUseResultToText(toolUseResult: unknown): string | null {
    if (!toolUseResult || typeof toolUseResult !== 'object') return null;
    const content = (toolUseResult as { content?: unknown }).content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return null;
    const parts: string[] = [];
    for (const block of content) {
        if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
            parts.push((block as { text: string }).text);
        }
    }
    return parts.length > 0 ? parts.join('\n') : null;
}

export function toolUseResultStatus(toolUseResult: unknown): 'async_launched' | 'completed' | 'unknown' {
    if (!toolUseResult || typeof toolUseResult !== 'object') return 'unknown';
    const status = (toolUseResult as { status?: unknown }).status;
    if (status === 'async_launched') return 'async_launched';
    if (status === 'completed') return 'completed';
    return 'unknown';
}

export type SubagentRunStats = { toolUses?: number; totalTokens?: number; durationMs?: number; toolStats?: Record<string, unknown> };

export function toolUseResultStats(toolUseResult: unknown): SubagentRunStats | undefined {
    if (!toolUseResult || typeof toolUseResult !== 'object') return undefined;
    const r = toolUseResult as Record<string, unknown>;
    const stats: SubagentRunStats = {};
    if (typeof r.totalToolUseCount === 'number') stats.toolUses = r.totalToolUseCount;
    if (typeof r.totalTokens === 'number') stats.totalTokens = r.totalTokens;
    if (typeof r.totalDurationMs === 'number') stats.durationMs = r.totalDurationMs;
    if (r.toolStats && typeof r.toolStats === 'object') stats.toolStats = r.toolStats as Record<string, unknown>;
    return Object.keys(stats).length > 0 ? stats : undefined;
}

export type NotificationFields = {
    toolUseId: string | null;
    taskId: string | null;
    status: 'completed' | 'failed' | 'stopped' | null;
    summary: string | null;
    result: SubagentResult | null;
};

/** Parse the `<task-notification>` user message text. */
export function parseTaskNotificationText(text: string): NotificationFields | null {
    if (!/<task-notification>/i.test(text)) return null;
    const pick = (tag: string) => text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'))?.[1] ?? null;
    const rawStatus = pick('status')?.trim().toLowerCase() ?? null;
    const status = rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'stopped' ? rawStatus : null;
    let resultText = pick('result');
    let result: SubagentResult | null = null;
    if (resultText !== null) {
        resultText = resultText
            .replace(/^\s*\[harness:[^\]]*\]\s*/i, '')
            .replace(/<usage>[\s\S]*?<\/usage>/gi, '')
            .trim();
        if (resultText.length > 0) result = capSubagentText(resultText);
    }
    return {
        toolUseId: pick('tool-use-id')?.trim() || null,
        taskId: pick('task-id')?.trim() || null,
        status,
        summary: pick('summary')?.trim() || null,
        result,
    };
}

export type ProgressThrottleState = { lastAt: number; lastToolUses: number };

/** Emit a progress envelope only when tool count changed AND ≥5s passed (or first time). */
export function shouldEmitProgress(previous: ProgressThrottleState | undefined, toolUses: number, now: number): boolean {
    if (!previous) return true;
    if (previous.lastToolUses === toolUses) return false;
    return now - previous.lastAt >= SUBAGENT_PROGRESS_MIN_INTERVAL_MS;
}
