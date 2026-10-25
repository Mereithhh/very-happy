/**
 * B-815: prompts for the server prompt queue (B-509) that the server has not
 * accepted yet, in the B-814 persistent outbox — a reload or a closed tab
 * used to lose them (「未加入队列 · 重试」 lived only in the tab's memory).
 *
 * Same store as the message outbox, marked `kind: 'queue'`: one takeover
 * (tabLiveness + the `vh-outbox-claim` lock), one 10-minute rule, one
 * cache-off / quota / logout lifecycle. sync.ts routes a taken-over row by its
 * kind — a queue row is re-enqueued (POST /prompt-queue, same localId), never
 * POSTed as a message, and a message row never lands in the dock.
 */
import type { OutboxRow, OutboxStore } from './cache/outboxStore';
import type { PendingPrompt, PendingPromptPersistence } from './promptQueue';

/** Same bound as a message POST waits for its row (sync.ts OUTBOX_PERSIST_WAIT_MS). */
export const QUEUE_PERSIST_WAIT_MS = 1_000;

export function isQueueRow(row: Pick<OutboxRow, 'kind'>): boolean {
    return row.kind === 'queue';
}

/** The outbox row of an unaccepted prompt; `body` is the record the POST carries. */
export function queueOutboxRow(sessionId: string, row: PendingPrompt & { content: string }, createdAt: number, ownerTabId: string): OutboxRow {
    return {
        localId: row.localId, sid: sessionId, body: row.content, createdAt, state: 'queued',
        attempts: 0, ownerTabId, group: row.localId, order: 0, kind: 'queue',
    };
}

/** Resolves when `promise` settles or after `ms`, whichever is first; never rejects. */
function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        promise.then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
    });
}

export function createQueueOutboxPersistence(deps: {
    store: Pick<OutboxStore, 'update' | 'remove'>;
    tabId: () => string;
    now?: () => number;
    waitMs?: number;
}): PendingPromptPersistence {
    const now = deps.now ?? Date.now;
    return {
        save: (sessionId, row, retried) => {
            const at = now();
            const ownerTabId = deps.tabId();
            // A row already on disk (a retry, or one adopted after a reload) keeps
            // its clock unless the user retried it; it is queued and ours again.
            const saved = deps.store.update([row.localId], (stored) => ({
                ...stored,
                body: row.content,
                state: 'queued',
                ownerTabId,
                ...(retried ? { createdAt: at, attempts: stored.attempts + 1 } : {}),
            }), () => queueOutboxRow(sessionId, row, retried ? at : row.createdAt, ownerTabId));
            return settleWithin(saved, deps.waitMs ?? QUEUE_PERSIST_WAIT_MS);
        },
        fail: (localIds) => { void deps.store.update(localIds, (stored) => ({ ...stored, state: 'failed' })); },
        forget: (localIds) => { void deps.store.remove(localIds); },
    };
}
