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
    /** B-942: the wrapper's own "this record was not saved" line — never replaced again. */
    notice?: boolean;
    /**
     * B-951: the item is a turn-start, kept in plaintext so a refused one can be
     * rebuilt — without it the turn's `turn-end` has no opening and the turn never ends.
     */
    turnStart?: { role: string; turn?: string; subagent?: string; time: number };
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

/**
 * B-942 — what the outbox does when the server answers a batch with an error.
 *
 * Before this every error was retried forever (InvalidateSync backoff), and the
 * outbox is FIFO: one batch the server can never accept held back everything
 * written after it. A Codex session on 0.2.178 posted the same batch 26,000
 * times over 7 hours (HTTP 413 each time) while it answered three more prompts
 * nobody ever saw — the wrapper, Codex and the turns were all fine.
 *
 * - `retry`: the server may take it later (network, 5xx, 429, auth, 404) —
 *   the old behaviour.
 * - `split`: the server refused the request as a whole (413 body too large,
 *   400/422 a message it will not take); send half as many next time to find
 *   the one it refuses.
 * - `replace`: a single message the server will never take: put a short
 *   notice in its place so the rest of the session goes out, and the person
 *   reading it can see that something is missing.
 */
export type OutboxRejection = 'retry' | 'split' | 'replace';

const PERMANENT_REJECTIONS = new Set([400, 413, 422]);

/**
 * `errorCode`: the server's `error` field. An account quota (`message_bytes_quota_exceeded`,
 * also a 413) is about the account, not this message — dropping messages would not help.
 */
export function classifyOutboxRejection(status: number | undefined, batchCount: number, errorCode?: unknown): OutboxRejection {
    if (status === undefined || !PERMANENT_REJECTIONS.has(status)) return 'retry';
    if (typeof errorCode === 'string' && errorCode.endsWith('_quota_exceeded')) return 'retry';
    return batchCount > 1 ? 'split' : 'replace';
}

/** B-942: the visible line that stands in for a message the server refused. */
export function outboxRejectedNotice(bytes: number, status: number | 'oversize'): string {
    const size = bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
    const why = status === 'oversize' ? 'it is larger than the server accepts' : `the server refused it (HTTP ${status})`;
    return `A ${size} record from this session was not saved: ${why}. The output after it continues below.`;
}
