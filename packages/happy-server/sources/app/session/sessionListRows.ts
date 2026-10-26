import type { Prisma, PrismaClient } from "@prisma/client";

/** The newest rows by `updatedAt` — archived or not (the Archived view's history). */
export const SESSION_LIST_RECENT = 150;
/** Unarchived rows outside the recent window ride along up to this many. */
export const SESSION_LIST_UNARCHIVED_MAX = 500;

/**
 * The account's own rows for `GET /v1/sessions`: the SESSION_LIST_RECENT
 * newest by `updatedAt`, plus every unarchived row outside that window (up
 * to SESSION_LIST_UNARCHIVED_MAX, newest first).
 *
 * Why (Owner 10-27, 「侧边栏的会话会突然变少，然后再加载回完整的 list」):
 * the list used to be the 150-row window alone. On a big account, rows that
 * moved recently — archived team members, terminal mirrors, heartbeating
 * sessions — push live sessions out of it. A long-lived tab still showed
 * them (the Web store only merges), but every fresh page load (reload, a new
 * build taking over, a phone restoring a discarded tab) started from the
 * window and lost them, until a later update or list pulled each one back
 * in. The sidebar's list view is the unarchived set, so that set is always
 * whole here; only archived history stays windowed.
 */
export async function sessionListRows<S extends Prisma.SessionSelect & { id: true }>(
    db: Pick<PrismaClient, 'session'>,
    accountId: string,
    select: S,
    limits: { recent?: number; unarchived?: number } = {},
): Promise<Prisma.SessionGetPayload<{ select: S }>[]> {
    const recent = await db.session.findMany({
        where: { accountId },
        orderBy: { updatedAt: 'desc' },
        take: limits.recent ?? SESSION_LIST_RECENT,
        select,
    });
    const unarchived = await db.session.findMany({
        where: { accountId, archivedAt: null, id: { notIn: recent.map((row) => (row as unknown as { id: string }).id) } },
        orderBy: { updatedAt: 'desc' },
        take: limits.unarchived ?? SESSION_LIST_UNARCHIVED_MAX,
        select,
    });
    return [...recent, ...unarchived];
}
