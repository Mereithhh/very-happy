import { z } from 'zod';

/**
 * B-982 global notices. The operator lists them in the server's instance
 * config (`notices` section); `GET /v1/notices` returns the ones addressed to
 * the signed-in account whose time window is open now, newest first.
 *
 * Readers parse each notice on its own (`parseNoticesResponse`): a notice a
 * newer server shapes differently is skipped, never the whole list, and an
 * unknown level reads as `info`. An older server answers 404 = no notices.
 */

export const NOTICES_PATH = '/v1/notices';

/** Operator-chosen id; also the key a dismissal is remembered under. */
export const NoticeIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/);
export const NoticeLevelSchema = z.enum(['info', 'warning']);
export type NoticeLevel = z.infer<typeof NoticeLevelSchema>;

export const NOTICE_TITLE_MAX = 120;
export const NOTICE_BODY_MAX = 2000;

export const NoticeViewSchema = z.object({
    id: NoticeIdSchema,
    title: z.string().max(NOTICE_TITLE_MAX),
    body: z.string().max(NOTICE_BODY_MAX),
    level: NoticeLevelSchema.catch('info'),
    dismissible: z.boolean().catch(true),
    startsAt: z.string().optional().catch(undefined),
    endsAt: z.string().optional().catch(undefined),
});
export type NoticeView = z.infer<typeof NoticeViewSchema>;

export const NoticesResponseSchema = z.object({ notices: z.array(NoticeViewSchema) });
export type NoticesResponse = z.infer<typeof NoticesResponseSchema>;

/** Lenient reader: keeps every notice that parses, drops the rest; anything else is an empty list. */
export function parseNoticesResponse(json: unknown): NoticeView[] {
    const list = json && typeof json === 'object' ? (json as { notices?: unknown }).notices : undefined;
    if (!Array.isArray(list)) return [];
    const out: NoticeView[] = [];
    for (const item of list) {
        const parsed = NoticeViewSchema.safeParse(item);
        if (parsed.success) out.push(parsed.data);
    }
    return out;
}
