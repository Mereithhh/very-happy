import { z } from 'zod';

/** Runtime context occupancy, never cumulative billing. null after compaction is unknown. */
export const ContextUsageSchema = z.object({
    source: z.literal('pi'),
    tokens: z.number().finite().nonnegative().nullable(),
    contextWindow: z.number().finite().positive(),
    updatedAt: z.number().finite().nonnegative(),
});
export type ContextUsage = z.infer<typeof ContextUsageSchema>;
