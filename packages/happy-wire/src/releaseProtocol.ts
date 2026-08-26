import { z } from 'zod';

export const ReleaseSlotSchema = z.enum(['blue', 'green']);

export const ReleaseDrainNoticeSchema = z.object({
    epoch: z.string().regex(/^[A-Za-z0-9._-]{8,128}$/),
    fromRelease: z.string().regex(/^[0-9a-f]{40}$/),
    toRelease: z.string().regex(/^[0-9a-f]{40}$/),
    candidateSlot: ReleaseSlotSchema,
    deadline: z.number().int().positive(),
    mode: z.literal('make-before-break'),
});

export type ReleaseSlot = z.infer<typeof ReleaseSlotSchema>;
export type ReleaseDrainNotice = z.infer<typeof ReleaseDrainNoticeSchema>;
