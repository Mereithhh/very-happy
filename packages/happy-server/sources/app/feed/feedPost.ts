import { Context } from "@/context";
import { FeedBody, UserFeedItem } from "./types";
import { afterTx, Tx } from "@/storage/inTx";
import { allocateUserSeq } from "@/storage/seq";
import { eventRouter, buildNewFeedPostUpdate } from "@/app/events/eventRouter";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import {
    assertAccountResourceQuota,
    configuredResourceLimit,
    enforceAccountWriteRate,
    lockAccountResources,
} from '@/app/api/resourceLimits';
import { FeedBodySchema, feedRepeatKeySchema } from './types';

type FeedUsage = { count: bigint; bytes: bigint; incoming_bytes: bigint; existing_bytes: bigint };

async function feedUsage(tx: Tx, accountId: string, body: FeedBody, repeatKey: string | null) {
    const rows = await tx.$queryRawUnsafe<FeedUsage[]>(
        `SELECT
            (SELECT COUNT(*)::bigint FROM "UserFeedItem" WHERE "userId" = $1) AS "count",
            (SELECT COALESCE(SUM(octet_length("body"::text) + COALESCE(octet_length("repeatKey"), 0)), 0)::bigint
             FROM "UserFeedItem" WHERE "userId" = $1) AS "bytes",
            (octet_length($2::jsonb::text) + octet_length(COALESCE($3, '')))::bigint AS "incoming_bytes",
            COALESCE((SELECT octet_length("body"::text) + COALESCE(octet_length("repeatKey"), 0)
                      FROM "UserFeedItem" WHERE "userId" = $1 AND "repeatKey" = $3), 0)::bigint AS "existing_bytes"`,
        accountId,
        JSON.stringify(body),
        repeatKey,
    );
    const row = rows[0];
    return {
        count: Number(row?.count ?? 0),
        bytes: Number(row?.bytes ?? 0),
        incomingBytes: Number(row?.incoming_bytes ?? 0),
        existingBytes: Number(row?.existing_bytes ?? 0),
    };
}

export async function enforceFeedWriteRate(accountId: string) {
    await enforceAccountWriteRate({
        accountId,
        resource: 'feed',
        envName: 'MAX_FEED_WRITES_PER_ACCOUNT_PER_MINUTE',
        fallback: 120,
    });
}

/**
 * Add a post to user's feed.
 * If repeatKey is provided and exists, the post will be updated in-place.
 * Otherwise, a new post is created with an incremented counter.
 */
export async function feedPost(
    tx: Tx,
    ctx: Context,
    body: FeedBody,
    repeatKey?: string | null
): Promise<UserFeedItem> {
    const parsedBody = FeedBodySchema.parse(body);
    const parsedRepeatKey = feedRepeatKeySchema.parse(repeatKey ?? null);
    await lockAccountResources(tx, ctx.uid);
    const existing = parsedRepeatKey
        ? await tx.userFeedItem.findUnique({
            where: { userId_repeatKey: { userId: ctx.uid, repeatKey: parsedRepeatKey } },
        })
        : null;
    const usage = await feedUsage(tx, ctx.uid, parsedBody, parsedRepeatKey);
    assertAccountResourceQuota({
        resource: 'feed',
        current: { count: usage.count, bytes: usage.bytes },
        delta: {
            count: existing ? 0 : 1,
            bytes: usage.incomingBytes - usage.existingBytes,
        },
        limits: {
            count: configuredResourceLimit('MAX_FEED_ITEMS_PER_ACCOUNT', 10_000),
            bytes: configuredResourceLimit('MAX_FEED_BYTES_PER_ACCOUNT', 64 * 1024 * 1024),
        },
    });

    // Allocate new counter
    const user = await tx.account.update({
        where: { id: ctx.uid },
        select: { feedSeq: true },
        data: { feedSeq: { increment: 1 } }
    });

    const item = existing
        ? await tx.userFeedItem.update({
            where: { id: existing.id },
            data: {
                counter: user.feedSeq,
                body: parsedBody,
                createdAt: new Date(),
            },
        })
        : await tx.userFeedItem.create({
            data: {
                counter: user.feedSeq,
                userId: ctx.uid,
                repeatKey: parsedRepeatKey,
                body: parsedBody,
            },
        });

    const result = {
        ...item,
        createdAt: item.createdAt.getTime(),
        cursor: '0-' + item.counter.toString(10)
    };

    // Emit socket event after transaction completes
    afterTx(tx, async () => {
        const updateSeq = await allocateUserSeq(ctx.uid);
        const updatePayload = buildNewFeedPostUpdate(result, updateSeq, randomKeyNaked(12));

        eventRouter.emitUpdate({
            userId: ctx.uid,
            payload: updatePayload,
            recipientFilter: { type: 'user-scoped-only' }
        });
    });

    return result;
}
