/**
 * B-836 in-app feedback — REST client (`specs/2026-10-feedback.md`). Every
 * call returns parsed data or throws FeedbackApiError with the server's
 * stable error code (`feedback_rate_limited`, `not_found`, …).
 */
import { z } from 'zod';
import { getCurrentAuth } from '@/auth/AuthContext';
import { assertNotAuthFailure } from '@/auth/authLatch';
import { getHappyClientId } from './apiSocket';
import { getServerUrl } from './serverConfig';
import type { FeedbackDiagnostics, FeedbackRating } from '@/app/feedback/feedbackPolicy';

export class FeedbackApiError extends Error {
    constructor(readonly code: string, readonly status: number) {
        super(code);
    }
}

const RatingSchema = z.enum(['good', 'ok', 'bad']);
const FeedbackViewSchema = z.object({
    id: z.string(),
    rating: RatingSchema,
    text: z.string().nullable(),
    diagnostics: z.record(z.string(), z.unknown()).nullable(),
    source: z.string(),
    createdAt: z.number(),
    readAt: z.number().nullable(),
});
export type FeedbackView = z.infer<typeof FeedbackViewSchema>;

const FeedbackAdminItemSchema = FeedbackViewSchema.extend({
    account: z.object({ id: z.string(), displayName: z.string(), username: z.string().nullable(), email: z.string().nullable() }),
});
export type FeedbackAdminItem = z.infer<typeof FeedbackAdminItemSchema>;

const FeedbackListSchema = z.object({ items: z.array(FeedbackAdminItemSchema), nextCursor: z.string().nullable(), unreadCount: z.number() });
export type FeedbackList = z.infer<typeof FeedbackListSchema>;

/** Same transport as apiAttention (no socket needed — the device harness answers it in-page). */
async function call<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
    const credentials = getCurrentAuth()?.credentials;
    if (!credentials) throw new FeedbackApiError('unauthorized', 401);
    const response = await fetch(`${getServerUrl()}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${credentials.token}`, 'X-Happy-Client': getHappyClientId(), ...init?.headers },
    });
    assertNotAuthFailure(response, 'apiFeedback');
    if (!response.ok) {
        let code = `http_${response.status}`;
        try {
            const body = await response.json() as { error?: unknown };
            if (typeof body.error === 'string') code = body.error;
        } catch { /* non-JSON error body */ }
        throw new FeedbackApiError(code, response.status);
    }
    return schema.parse(await response.json());
}

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export function postFeedback(input: { rating: FeedbackRating; text?: string | null; diagnostics?: FeedbackDiagnostics | null; source: 'manual' | 'prompt' }): Promise<{ feedback: FeedbackView; deduped: boolean }> {
    return call('/v1/feedback', z.object({ feedback: FeedbackViewSchema, deduped: z.boolean() }), json('POST', input));
}

/** The prompt card's follow-up: add text / diagnostics to a one-tap rating (sender only, within an hour). */
export function amendFeedback(id: string, input: { rating?: FeedbackRating; text?: string | null; diagnostics?: FeedbackDiagnostics | null }): Promise<{ feedback: FeedbackView }> {
    return call(`/v1/feedback/${encodeURIComponent(id)}`, z.object({ feedback: FeedbackViewSchema }), json('PATCH', input));
}

/** False on any failure — an older server without the routes simply has no inbox. */
export async function fetchFeedbackAdminAccess(): Promise<boolean> {
    try {
        return (await call('/v1/feedback/admin/access', z.object({ admin: z.boolean() }))).admin;
    } catch {
        return false;
    }
}

export function listFeedback(query: { cursor?: string | null; unread?: boolean; rating?: FeedbackRating | null; limit?: number } = {}): Promise<FeedbackList> {
    const params = new URLSearchParams();
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.unread) params.set('unread', 'true');
    if (query.rating) params.set('rating', query.rating);
    params.set('limit', String(query.limit ?? 30));
    return call(`/v1/feedback/admin?${params}`, FeedbackListSchema);
}

export function markFeedbackRead(id: string, read: boolean): Promise<{ feedback: FeedbackView }> {
    return call(`/v1/feedback/admin/${encodeURIComponent(id)}/read`, z.object({ feedback: FeedbackViewSchema }), json('POST', { read }));
}
