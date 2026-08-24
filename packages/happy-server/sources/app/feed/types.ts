import * as z from "zod";
import { utf8StringSchema } from '@/app/api/resourceSchemas';

export const FEED_ID_MAX_BYTES = 256;
export const FEED_ENCRYPTED_BODY_MAX_BYTES = 64 * 1024;
export const FEED_TEXT_MAX_BYTES = 4 * 1024;
export const feedIdSchema = utf8StringSchema({ minBytes: 1, maxBytes: FEED_ID_MAX_BYTES });
export const feedRepeatKeySchema = utf8StringSchema({ minBytes: 1, maxBytes: FEED_ID_MAX_BYTES }).nullable();

export const FeedBodySchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('friend_request'), uid: feedIdSchema }).strict(),
    z.object({ kind: z.literal('friend_accepted'), uid: feedIdSchema }).strict(),
    z.object({ kind: z.literal('text'), text: utf8StringSchema({ maxBytes: FEED_TEXT_MAX_BYTES }) }).strict(),
    z.object({
        kind: z.literal('notification'),
        notifType: z.enum(['permission_request', 'reply_done', 'input_needed', 'error']),
        sessionId: feedIdSchema,
        enc: utf8StringSchema({ minBytes: 1, maxBytes: FEED_ENCRYPTED_BODY_MAX_BYTES }),
    }).strict()
]);

export type FeedBody = z.infer<typeof FeedBodySchema>;

export interface UserFeedItem {
    id: string;
    userId: string;
    repeatKey: string | null;
    body: FeedBody;
    createdAt: number;
    cursor: string;
}

export interface FeedCursor {
    before?: string;
    after?: string;
}

export interface FeedOptions {
    limit?: number;
    cursor?: FeedCursor;
}

export interface FeedResult {
    items: UserFeedItem[];
    hasMore: boolean;
}
