import { NOTICES_PATH, type NoticesResponse } from '@slopus/happy-wire';
import type { Fastify } from '../types';
import { instanceConfig } from '@/app/instance/instanceConfig';
import { noticesNeedUsername, visibleNotices } from '@/app/notices/notices';
import { db } from '@/storage/db';

/**
 * B-982 global notices: the operator's `notices` from the instance config,
 * filtered to the caller's audience and the current time window. Dismissal
 * lives in the account's synced settings (`dismissedNoticeIds`), so the
 * server keeps no per-account state here.
 */
export function noticesRoutes(app: Fastify) {
    app.get(NOTICES_PATH, { preHandler: app.authenticate }, async (request, reply): Promise<NoticesResponse> => {
        reply.header('cache-control', 'no-store');
        const notices = instanceConfig().notices;
        if (notices.length === 0) return { notices: [] };
        let username: string | null = null;
        if (noticesNeedUsername(notices)) {
            username = (await db.account.findUnique({ where: { id: request.userId }, select: { username: true } }))?.username ?? null;
        }
        return { notices: visibleNotices(notices, { accountId: request.userId, username }, Date.now()) };
    });
}
