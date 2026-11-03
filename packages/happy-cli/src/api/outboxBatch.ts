/**
 * B-880 — how the session outbox splits into POST /v3/sessions/:id/messages
 * requests.
 *
 * The outbox used to send 50 messages per POST regardless of size. The
 * server's request body limit is 1 MiB (HTTP_BODY_LIMIT_BYTES), and a replayed
 * import fills every batch: 50 envelopes carrying large `Write` inputs (tool
 * arguments are not capped) answer 413 on every retry, so the session's
 * history stopped at seq 1 for good and nothing after it was ever sent
 * (reproduced: 300-line transcript with 60 KB Write inputs, 627 × 413).
 *
 * Pure, no I/O. A batch is the longest prefix that
 *  - has at most `maxCount` items (the server takes 100),
 *  - stays within `maxBytes` of request body, and
 *  - does not mix a history backfill with live messages: a backfill batch
 *    carries `x-happy-message-origin: backfill` (specs/2026-11-long-import-backfill.md).
 * A single item that can never fit in one request (`maxItemBytes`) is reported
 * as `oversize`: the server would reject it on every retry and block every
 * message behind it.
 */

export interface OutboxItem {
    content: string;
    localId: string;
    /** Part of a replayed transcript (import / fork backfill). */
    backfill?: boolean;
}

export interface OutboxBatchLimits {
    maxCount: number;
    maxBytes: number;
    maxItemBytes: number;
}

/** Body budget below the server's 1 MiB default, with room for the JSON envelope. */
export const OUTBOX_BATCH_LIMITS: OutboxBatchLimits = {
    maxCount: 100,
    maxBytes: 768 * 1024,
    maxItemBytes: 1024 * 1024 - 4 * 1024,
};

export type OutboxBatchPlan =
    | { kind: 'send'; count: number; backfill: boolean }
    | { kind: 'oversize'; bytes: number };

/** Request-body bytes one item costs (`content` is base64 — ASCII). */
export function outboxItemBytes(item: OutboxItem): number {
    return item.content.length + item.localId.length + 32;
}

export function planOutboxBatch(items: readonly OutboxItem[], limits: OutboxBatchLimits = OUTBOX_BATCH_LIMITS): OutboxBatchPlan | null {
    const first = items[0];
    if (!first) return null;
    const firstBytes = outboxItemBytes(first);
    if (firstBytes > limits.maxItemBytes) return { kind: 'oversize', bytes: firstBytes };
    const backfill = first.backfill === true;
    let count = 1;
    let bytes = firstBytes;
    while (count < items.length && count < limits.maxCount) {
        const next = items[count];
        if ((next.backfill === true) !== backfill) break;
        const nextBytes = outboxItemBytes(next);
        if (nextBytes > limits.maxItemBytes || bytes + nextBytes > limits.maxBytes) break;
        bytes += nextBytes;
        count += 1;
    }
    return { kind: 'send', count, backfill };
}
