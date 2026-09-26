import { z } from 'zod';

// B-509 server-side prompt queue. A queued prompt is stored per session as an
// opaque encrypted record — exactly the user `RawRecord` the web would have sent
// as a message — and the session's wrapper turns the head item into an ordinary
// `SessionMessage` (same `localId`) once its own input queue is empty and it is
// waiting for the next turn. Request schemas are strict; response shapes are
// plain TS types so clients tolerate fields added by newer servers (AGENTS #4).

export const PROMPT_QUEUE_CAPABILITY = 'prompt-queue-v1';
export const PROMPT_QUEUE_MAX_ITEMS = 50;
export const PROMPT_QUEUE_LOCAL_ID_MAX_BYTES = 256;

export const PromptQueueEncryptedContentSchema = z.object({
    t: z.literal('encrypted'),
    c: z.string(),
});
export type PromptQueueEncryptedContent = z.infer<typeof PromptQueueEncryptedContentSchema>;

export const PromptQueueItemSchema = z.object({
    id: z.string(),
    localId: z.string(),
    position: z.number(),
    content: PromptQueueEncryptedContentSchema,
    createdAt: z.number(),
    updatedAt: z.number(),
});
export type PromptQueueItem = z.infer<typeof PromptQueueItemSchema>;

export const PromptQueueEnqueueSchema = z.object({
    localId: z.string().min(1).max(PROMPT_QUEUE_LOCAL_ID_MAX_BYTES),
    content: z.string().min(1),
});
export type PromptQueueEnqueue = z.infer<typeof PromptQueueEnqueueSchema>;

export const PromptQueueUpdateContentSchema = z.object({
    content: z.string().min(1),
});

export const PromptQueueOrderSchema = z.object({
    ids: z.array(z.string().min(1).max(128)).min(1).max(PROMPT_QUEUE_MAX_ITEMS),
});

/** Socket `update` body broadcast to every connection interested in the session
 *  after each queue mutation. Full snapshot: queues are small (≤ 50 items). */
export const UpdatePromptQueueBodySchema = z.object({
    t: z.literal('prompt-queue'),
    sid: z.string(),
    items: z.array(PromptQueueItemSchema),
});
export type UpdatePromptQueueBody = z.infer<typeof UpdatePromptQueueBodySchema>;

export type PromptQueueDispatchResponse = {
    dispatched: { itemId: string; localId: string; messageId: string; seq: number } | null;
    remaining: number;
};
