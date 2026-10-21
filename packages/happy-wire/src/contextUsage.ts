import { z } from 'zod';

/**
 * Runtime context occupancy, never cumulative billing. null after compaction is unknown.
 *
 * B-727 (specs/2026-10-pi-context-usage.md): `contextWindow` stays required so
 * older webs keep rendering; `windowSource` says whether it may be used as a
 * denominator. Free strings + read whitelist (iron rule 14): an unknown value
 * must not make the whole agentState fail to parse.
 */
export const ContextUsageSchema = z.object({
    source: z.literal('pi'),
    tokens: z.number().finite().nonnegative().nullable(),
    contextWindow: z.number().finite().positive(),
    updatedAt: z.number().finite().nonnegative(),
    /** 'configured' (the harness's own model entry) | 'inferred' (same model id in a known table) | 'unknown' (harness default). Absent = older CLI → configured. */
    windowSource: z.string().nullable().optional(),
    /** Model id the snapshot was measured on (lets the web consult its own table when the window is unknown). */
    model: z.string().nullable().optional(),
    /** When the harness last compacted; tokens stay null until the next answer measures the new context. */
    compactedAt: z.number().finite().nonnegative().nullable().optional(),
});
export type ContextUsage = z.infer<typeof ContextUsageSchema>;

export type ContextWindowSource = 'configured' | 'inferred' | 'unknown';

/** Read whitelist for `windowSource`; anything unrecognized (or absent) is the pre-B-727 meaning. */
export function contextWindowSourceOf(usage: Pick<ContextUsage, 'windowSource'> | null | undefined): ContextWindowSource {
    const v = usage?.windowSource;
    return v === 'inferred' || v === 'unknown' ? v : 'configured';
}
