import { z } from 'zod';

/**
 * B-836 in-app feedback — the pure half (`specs/2026-10-feedback.md`).
 * Feedback is stored only in this server's database; nothing here talks to
 * another service. Readers are the accounts in `VH_FEEDBACK_ADMIN_ACCOUNT_IDS`.
 */

export const FEEDBACK_RATINGS = ['bad', 'ok', 'good'] as const;
export type FeedbackRating = (typeof FEEDBACK_RATINGS)[number];
export const FEEDBACK_TEXT_MAX = 2000;
/** A resend of the same rating + text inside this window returns the first row. */
export const FEEDBACK_DEDUPE_MS = 10 * 60_000;
/** The prompt card lets its sender add text / diagnostics to a one-tap rating for this long. */
export const FEEDBACK_AMEND_MS = 60 * 60_000;
/** At most one push per admin per window; the rest are counted into the next one. */
export const FEEDBACK_PUSH_WINDOW_MS = 5 * 60_000;

export function ratingToScore(rating: FeedbackRating): number {
    return FEEDBACK_RATINGS.indexOf(rating) + 1;
}
export function scoreToRating(score: number): FeedbackRating {
    return FEEDBACK_RATINGS[Math.min(Math.max(score, 1), 3) - 1];
}

export class FeedbackError extends Error {
    constructor(readonly code: string, readonly status: number) {
        super(code);
        this.name = 'FeedbackError';
    }
}

/** `VH_FEEDBACK_ADMIN_ACCOUNT_IDS`: comma / whitespace separated. Unset = nobody can read feedback. */
export function feedbackAdminIds(raw = process.env.VH_FEEDBACK_ADMIN_ACCOUNT_IDS): Set<string> {
    return new Set((raw ?? '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean));
}
export function isFeedbackAdmin(accountId: string, raw?: string): boolean {
    return feedbackAdminIds(raw).has(accountId);
}

const ID_SEGMENT = /^(?:[0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{16,})$/i;

/**
 * A route as a pattern: no query, no hash, and every id-like segment
 * (numbers, uuids, long tokens with a digit) replaced by `:id`. The web
 * client does the same before showing the payload; this is the server's
 * own guarantee that a session / machine id never lands in the table.
 */
export function routePattern(route: string): string {
    const path = route.split(/[?#]/, 1)[0] || '/';
    return path.split('/').map(seg => (seg && ID_SEGMENT.test(seg) ? ':id' : seg)).join('/').slice(0, 200) || '/';
}

/**
 * The only diagnostics the server keeps. Unknown keys are dropped (zod
 * strips them), so a newer client cannot widen what is stored.
 */
export const FeedbackDiagnosticsSchema = z.object({
    webVersion: z.string().max(64).optional(),
    cliVersions: z.array(z.string().max(32)).max(10).optional(),
    userAgent: z.string().max(400).optional(),
    language: z.string().max(32).optional(),
    viewport: z.string().max(32).optional(),
    pointer: z.enum(['fine', 'coarse', 'none']).optional(),
    route: z.string().max(400).transform(routePattern).optional(),
    timeZone: z.string().max(64).optional(),
    ts: z.string().max(40).optional(),
});
export type FeedbackDiagnostics = z.infer<typeof FeedbackDiagnosticsSchema>;

const text = z.string().trim().max(FEEDBACK_TEXT_MAX);

export const FeedbackPostSchema = z.object({
    rating: z.enum(FEEDBACK_RATINGS),
    text: text.nullish(),
    diagnostics: FeedbackDiagnosticsSchema.nullish(),
    source: z.enum(['manual', 'prompt']).default('manual'),
});
export type FeedbackPost = z.infer<typeof FeedbackPostSchema>;

export const FeedbackAmendSchema = z.object({
    rating: z.enum(FEEDBACK_RATINGS).optional(),
    text: text.nullish(),
    diagnostics: FeedbackDiagnosticsSchema.nullish(),
});
export type FeedbackAmend = z.infer<typeof FeedbackAmendSchema>;

export const FeedbackListQuerySchema = z.object({
    cursor: z.string().max(64).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    unread: z.enum(['true', 'false']).optional(),
    rating: z.enum(FEEDBACK_RATINGS).optional(),
});
export type FeedbackListQuery = z.infer<typeof FeedbackListQuerySchema>;

export const FeedbackReadSchema = z.object({ read: z.boolean() });

const RATING_LABEL: Record<FeedbackRating, string> = { good: '👍 好用', ok: '😐 一般', bad: '👎 不好用' };

/** Push copy for one admin; `extra` = feedback that arrived while the previous push window was closed. */
export function feedbackPushPresentation(input: { rating: FeedbackRating; text: string | null; from: string; extra: number }): { title: string; body: string } {
    const more = input.extra > 0 ? `（另有 ${input.extra} 条）` : '';
    const body = input.text?.trim() ? input.text.trim().slice(0, 80) : '（未填写文字）';
    return { title: `新反馈 · ${RATING_LABEL[input.rating]}${more}`, body: `${input.from}：${body}` };
}

/**
 * In-process push throttle, one window per admin. Returns how many earlier
 * feedback rows this push stands for, or null when the window is still
 * closed (the row is counted into the next push). Multiple replicas each
 * keep their own window — at worst one push per replica per window.
 */
export function createPushThrottle(windowMs = FEEDBACK_PUSH_WINDOW_MS) {
    const state = new Map<string, { lastAt: number; skipped: number }>();
    return {
        take(adminId: string, now = Date.now()): number | null {
            const entry = state.get(adminId);
            if (entry && now - entry.lastAt < windowMs) {
                entry.skipped += 1;
                return null;
            }
            const extra = entry?.skipped ?? 0;
            state.set(adminId, { lastAt: now, skipped: 0 });
            return extra;
        },
    };
}
