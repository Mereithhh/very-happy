import { Prisma, type Feedback } from '@prisma/client';
import { configuredResourceLimit } from '@/app/api/resourceLimits';
import { allowAuthRequest } from '@/app/auth/authRateLimiter';
import { dispatchDeviceEventPush } from '@/app/push/pushDispatch';
import { displayNameOf, identityOf } from '@/app/social/accountDirectory';
import { db } from '@/storage/db';
import { log } from '@/utils/log';
import {
    createPushThrottle, FEEDBACK_AMEND_MS, FEEDBACK_DEDUPE_MS, FeedbackError, feedbackAdminIds, feedbackPushPresentation,
    isFeedbackAdmin, ratingToScore, scoreToRating,
    type FeedbackAmend, type FeedbackListQuery, type FeedbackPost, type FeedbackRating,
} from './rules';

/** B-836 feedback storage, admin list and owner push (`specs/2026-10-feedback.md`). */

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Two fixed windows on the shared DB limiter: per hour and per day. A refused
 * request is not charged (B-307), so a client retrying against a full
 * bucket does not push its own reset further out.
 */
async function enforceFeedbackRate(accountId: string): Promise<void> {
    const windows = [
        { key: `resource-write:feedback-day:${accountId}`, max: configuredResourceLimit('MAX_FEEDBACK_PER_ACCOUNT_PER_DAY', 20), windowMs: DAY_MS },
        { key: `resource-write:feedback-hour:${accountId}`, max: configuredResourceLimit('MAX_FEEDBACK_PER_ACCOUNT_PER_HOUR', 5), windowMs: HOUR_MS },
    ];
    for (const w of windows) {
        if (w.max === 0) continue;
        if (!(await allowAuthRequest(w.key, { max: w.max, windowMs: w.windowMs }))) throw new FeedbackError('feedback_rate_limited', 429);
    }
}

export type FeedbackView = {
    id: string;
    rating: FeedbackRating;
    text: string | null;
    diagnostics: unknown;
    source: string;
    createdAt: number;
    readAt: number | null;
};

function view(row: Feedback): FeedbackView {
    return {
        id: row.id,
        rating: scoreToRating(row.rating),
        text: row.text,
        diagnostics: row.diagnostics ?? null,
        source: row.source,
        createdAt: row.createdAt.getTime(),
        readAt: row.readAt?.getTime() ?? null,
    };
}

const pushThrottle = createPushThrottle();

async function notifyAdmins(row: Feedback): Promise<void> {
    const admins = [...feedbackAdminIds()].filter(id => id !== row.accountId);
    if (admins.length === 0) return;
    try {
        const account = await db.account.findUnique({ where: { id: row.accountId }, select: { firstName: true, lastName: true, username: true } });
        const from = account ? displayNameOf(account, await identityOf(row.accountId)) : 'someone';
        await Promise.all(admins.map(async adminId => {
            const extra = pushThrottle.take(adminId);
            if (extra === null) return;
            const { title, body } = feedbackPushPresentation({ rating: scoreToRating(row.rating), text: row.text, from, extra });
            await dispatchDeviceEventPush({ userId: adminId, title, body, data: { kind: 'feedback', feedbackId: row.id, url: '/settings/feedback' } });
        }));
    } catch (error) {
        log({ module: 'feedback', level: 'warn', error }, 'feedback push failed');
    }
}

export async function postFeedback(accountId: string, input: FeedbackPost): Promise<{ feedback: FeedbackView; deduped: boolean }> {
    const rating = ratingToScore(input.rating);
    const text = input.text?.trim() || null;
    // A resend (double tap, retry after a lost response) returns the first row
    // before touching the rate budget.
    const recent = await db.feedback.findFirst({
        where: { accountId, rating, text, createdAt: { gte: new Date(Date.now() - FEEDBACK_DEDUPE_MS) } },
        orderBy: { createdAt: 'desc' },
    });
    if (recent) return { feedback: view(recent), deduped: true };
    await enforceFeedbackRate(accountId);
    const row = await db.feedback.create({
        data: {
            accountId,
            rating,
            text,
            diagnostics: (input.diagnostics ?? undefined) as Prisma.InputJsonValue | undefined,
            source: input.source,
        },
    });
    void notifyAdmins(row);
    return { feedback: view(row), deduped: false };
}

/** The sender adds text / diagnostics to a one-tap rating from the prompt card. */
export async function amendFeedback(accountId: string, id: string, input: FeedbackAmend): Promise<{ feedback: FeedbackView }> {
    const row = await db.feedback.findFirst({ where: { id, accountId } });
    if (!row) throw new FeedbackError('feedback_not_found', 404);
    if (Date.now() - row.createdAt.getTime() > FEEDBACK_AMEND_MS) throw new FeedbackError('feedback_amend_expired', 409);
    const data: Prisma.FeedbackUpdateInput = {};
    if (input.rating) data.rating = ratingToScore(input.rating);
    if (input.text !== undefined) data.text = input.text?.trim() || null;
    // Unticking diagnostics on the follow-up clears what the one-tap rating sent.
    if (input.diagnostics !== undefined) data.diagnostics = input.diagnostics === null ? Prisma.DbNull : input.diagnostics as Prisma.InputJsonValue;
    const updated = await db.feedback.update({ where: { id }, data });
    return { feedback: view(updated) };
}

function requireAdmin(accountId: string): void {
    // Same answer as an older server without the routes: nothing here.
    if (!isFeedbackAdmin(accountId)) throw new FeedbackError('not_found', 404);
}

export type FeedbackAdminItem = FeedbackView & {
    account: { id: string; displayName: string; username: string | null; email: string | null };
};

export async function listFeedback(accountId: string, query: FeedbackListQuery): Promise<{ items: FeedbackAdminItem[]; nextCursor: string | null; unreadCount: number }> {
    requireAdmin(accountId);
    const where: Prisma.FeedbackWhereInput = {
        ...(query.unread === 'true' ? { readAt: null } : {}),
        ...(query.rating ? { rating: ratingToScore(query.rating) } : {}),
    };
    const [rows, unreadCount] = await Promise.all([
        db.feedback.findMany({
            where,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: query.limit + 1,
            ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
            include: { account: { select: { id: true, firstName: true, lastName: true, username: true } } },
        }),
        db.feedback.count({ where: { readAt: null } }),
    ]);
    const page = rows.slice(0, query.limit);
    const identities = new Map<string, Awaited<ReturnType<typeof identityOf>>>();
    for (const id of new Set(page.map(r => r.accountId))) identities.set(id, await identityOf(id));
    const items = page.map(row => {
        const identity = identities.get(row.accountId)!;
        return {
            ...view(row),
            account: {
                id: row.account.id,
                displayName: displayNameOf(row.account, identity),
                username: row.account.username ?? identity.handle,
                email: identity.email,
            },
        };
    });
    return { items, nextCursor: rows.length > query.limit ? page[page.length - 1].id : null, unreadCount };
}

export async function markFeedbackRead(accountId: string, id: string, read: boolean): Promise<{ feedback: FeedbackView }> {
    requireAdmin(accountId);
    const row = await db.feedback.findUnique({ where: { id } });
    if (!row) throw new FeedbackError('feedback_not_found', 404);
    const updated = await db.feedback.update({ where: { id }, data: { readAt: read ? (row.readAt ?? new Date()) : null } });
    return { feedback: view(updated) };
}
