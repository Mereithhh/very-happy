import { z } from 'zod';

// B-970: how full a dsh (DeepSeek Harness) session's context is. dsh's ACP
// server sends `usage_update { used, size }` after every committed assistant
// message (deepseek-harness packages/acp/acp/src/updates.ts: `used` is its own
// token meter over the session, `size` the model's context window). The
// wrapper mirrors it into agentState (`dshContextUsage`), a field of its own:
// `contextUsage` is pi's, and its `source: 'pi'` literal would make an older
// web drop the whole agentState. Wrappers that write it declare
// DSH_CONTEXT_CAPABILITY (AGENTS #14).

export const DSH_CONTEXT_CAPABILITY = 'dsh-context-v1';

export const DshContextUsageSchema = z.object({
    /** The dsh session the numbers belong to; a reader ignores another session's (fresh start after a failed resume). */
    sessionId: z.string(),
    tokens: z.number().finite().nonnegative(),
    contextWindow: z.number().finite().positive(),
    updatedAt: z.number(),
});
export type DshContextUsage = z.infer<typeof DshContextUsageSchema>;

/** agentState.dshContextUsage → usage, or null (absent or malformed). */
export function readDshContextUsage(raw: unknown): DshContextUsage | null {
    const parsed = DshContextUsageSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

/**
 * An ACP `usage_update` payload → occupancy, or null when it is not one dsh
 * measured (missing / non-finite `used`, no positive `size`).
 */
export function dshUsageUpdateOccupancy(raw: unknown): { tokens: number; contextWindow: number } | null {
    const update = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
    const used = update?.used;
    const size = update?.size;
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null;
    if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return null;
    return { tokens: used, contextWindow: size };
}
