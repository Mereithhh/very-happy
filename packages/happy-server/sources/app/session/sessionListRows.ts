import type { Prisma, PrismaClient } from "@prisma/client";

/** `GET /v1/sessions`: the account's newest rows by `updatedAt`, archived or not. */
export const SESSION_LIST_RECENT = 150;
/**
 * `GET /v1/sessions?scope=unarchived` returns at most this many — running ones
 * first, then newest (10-27 production: the biggest account has 381
 * unarchived rows, 343 of them outside the 150 newest; the next has 122).
 */
export const SESSION_LIST_UNARCHIVED_MAX = 500;

export type SessionListScope = 'recent' | 'unarchived';

/**
 * The account's own rows for `GET /v1/sessions`.
 *
 * `recent` (the default, every client since the beginning): the 150 newest
 * rows by `updatedAt`, archived or not.
 *
 * `unarchived` (Web, once per page load after `recent`): every unarchived
 * row, up to SESSION_LIST_UNARCHIVED_MAX. Why (Owner 10-27, 「侧边栏的会话会
 * 突然变少，然后再加载回完整的 list」): on a big account, rows that moved
 * recently — archived team members, terminal mirrors, heartbeating sessions —
 * push live sessions out of the 150. A long-lived tab still showed them (the
 * Web store only merges), but every fresh page load (reload, a new build
 * taking over, a phone restoring a discarded tab) started from the window and
 * lost them until a later update or list pulled each one back in (the Owner's
 * window held 38 of 381 unarchived rows). The sidebar's list view is exactly
 * the unarchived set. It is a second request, not part of `recent`: on the
 * biggest account it is ~3–4MB, and the first list must stay small enough to
 * get in on slow 4G (B-818).
 */
export async function sessionListRows<S extends Prisma.SessionSelect & { id: true }>(
    db: Pick<PrismaClient, 'session'>,
    accountId: string,
    select: S,
    scope: SessionListScope = 'recent',
    limits: { recent?: number; unarchived?: number } = {},
): Promise<Prisma.SessionGetPayload<{ select: S }>[]> {
    if (scope === 'unarchived') {
        return db.session.findMany({
            where: { accountId, archivedAt: null },
            orderBy: [{ active: 'desc' }, { updatedAt: 'desc' }],
            take: limits.unarchived ?? SESSION_LIST_UNARCHIVED_MAX,
            select,
        });
    }
    return db.session.findMany({
        where: { accountId },
        orderBy: { updatedAt: 'desc' },
        take: limits.recent ?? SESSION_LIST_RECENT,
        select,
    });
}
