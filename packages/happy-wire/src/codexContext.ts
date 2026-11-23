import { z } from 'zod';

// B-963: how full a Codex thread's context is, from the app-server's
// `thread/tokenUsage/updated` ({ total, last, modelContextWindow }). Occupancy
// is `last` (the newest request); `total` is the session's running sum and only
// feeds usage reports. The wrapper mirrors it into agentState
// (`codexContextUsage`), a field of its own: `contextUsage` is pi's, and its
// `source: 'pi'` literal would make an older web drop the whole agentState.
// Wrappers that write it declare CODEX_CONTEXT_CAPABILITY (AGENTS #14).

export const CODEX_CONTEXT_CAPABILITY = 'codex-context-v1';

/** Child threads kept in agentState, newest first. */
export const CODEX_CONTEXT_MAX_CHILDREN = 16;

const occupancy = {
    /** null = not measured since the history changed (rewind). */
    tokens: z.number().finite().nonnegative().nullable(),
    /** Codex's own window for the model; null when it reports none. */
    contextWindow: z.number().finite().positive().nullish(),
};

export const CodexContextUsageSchema = z.object({
    /** The session's own thread; a reader ignores the numbers of another thread (cleared, not resumed). */
    threadId: z.string(),
    ...occupancy,
    updatedAt: z.number(),
    /** The session's sub-agent threads, newest first. */
    children: z.array(z.object({ threadId: z.string(), ...occupancy })).nullish().catch(undefined),
});
export type CodexContextUsage = z.infer<typeof CodexContextUsageSchema>;

/** agentState.codexContextUsage → usage, or null (absent or malformed). */
export function readCodexContextUsage(raw: unknown): CodexContextUsage | null {
    const parsed = CodexContextUsageSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

/**
 * Occupancy of one ThreadTokenUsage. Input side of the newest request (cached
 * input is part of inputTokens), as the Claude meter counts. After a compaction
 * Codex reports an estimate with every breakdown field 0 and only totalTokens
 * set — that estimate is the occupancy, not 0.
 */
export function codexContextOccupancy(raw: unknown): { tokens: number; contextWindow: number | null } | null {
    const usage = raw && typeof raw === 'object' ? raw as Record<string, any> : null;
    const last = usage?.last && typeof usage.last === 'object' ? usage.last as Record<string, unknown> : null;
    if (!last) return null;
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
    const input = num(last.inputTokens);
    const tokens = input !== null && input > 0 ? input : num(last.totalTokens);
    if (!tokens) return null;
    const window = num(usage?.modelContextWindow);
    return { tokens, contextWindow: window && window > 0 ? window : null };
}
