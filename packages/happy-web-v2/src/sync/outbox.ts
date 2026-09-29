/**
 * B-513 — pure pieces of the Web send outbox (see
 * specs/2026-09-fast-session-and-send.md). `sync.ts` owns the wiring; these
 * decide what a send outcome means, so they are unit-tested on their own.
 */
import { isAuthFailure } from '@/auth/authLatch';

/** Wall-clock budget one outbox item gets before it is shown as failed. */
export const SEND_DEADLINE_MS = 15_000;

/** A non-2xx HTTP answer with the server's machine-readable code, when it sent one. */
export class ApiRequestError extends Error {
    readonly status: number;
    readonly code: string | null;
    constructor(status: number, code: string | null, message?: string) {
        super(message ?? `Request failed: ${status}${code ? ` (${code})` : ''}`);
        this.name = 'ApiRequestError';
        this.status = status;
        this.code = code;
    }
}

/** Throw an ApiRequestError for a non-2xx response, reading `{ error: code }` if present. */
export async function assertResponseOk(response: Response, what: string): Promise<void> {
    if (response.ok) return;
    let code: string | null = null;
    try {
        const body = await response.json() as { error?: unknown };
        if (typeof body?.error === 'string') code = body.error;
    } catch {
        // Not JSON — the status alone classifies it.
    }
    throw new ApiRequestError(response.status, code, `${what}: ${response.status}${code ? ` (${code})` : ''}`);
}

export type SendOutcome = {
    /**
     * `rejected`: the server answered and will never accept this batch as-is
     * (retrying is pointless). `auth`: 401/403 — also final. `retry`: transient.
     */
    kind: 'rejected' | 'auth' | 'retry';
    /** Could this attempt have stored the batch? Only a definite "no" allows taking it back. */
    mayHaveStored: boolean;
};

function isAbortError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/**
 * Classify a failed send attempt. Non-retryable: 400 (malformed), 404 (session
 * gone), 413 (byte quota), 429 `message_count_quota_exceeded` (count quota —
 * a plain 429 rate limit is retried), and 401/403. Any of these answers means
 * the server did not store the batch. Everything else is retried, and an
 * attempt that may have reached the server (timeout, abort, 5xx, or a network
 * error on a request dispatched while online) counts as maybe-stored.
 *
 * `onlineAtDispatch` is the browser's online state when the request was sent,
 * NOT when it failed: a request that left while online and failed because the
 * device dropped offline mid-flight may well have been stored (review B-513).
 */
export function classifySendError(error: unknown, onlineAtDispatch: boolean): SendOutcome {
    if (isAuthFailure(error)) return { kind: 'auth', mayHaveStored: false };
    if (error instanceof ApiRequestError) {
        const { status, code } = error;
        if (status === 400 || status === 404 || status === 413) return { kind: 'rejected', mayHaveStored: false };
        if (status === 429) {
            return code === 'message_count_quota_exceeded'
                ? { kind: 'rejected', mayHaveStored: false }
                : { kind: 'retry', mayHaveStored: false };
        }
        return { kind: 'retry', mayHaveStored: status >= 500 };
    }
    if (isAbortError(error)) return { kind: 'retry', mayHaveStored: true };
    // fetch rejects with a TypeError when the request never completed. Only a
    // request issued while the browser already reported offline never left.
    return { kind: 'retry', mayHaveStored: onlineAtDispatch };
}

/**
 * Start one send attempt: snapshot the online state at dispatch time, so the
 * later failure is judged by whether the request could have left at all.
 */
export function beginSendAttempt(isOnline: () => boolean): { classify: (error: unknown) => SendOutcome } {
    const onlineAtDispatch = isOnline();
    return { classify: (error) => classifySendError(error, onlineAtDispatch) };
}

/**
 * Per-item wall-clock deadlines that stop counting while the browser is
 * offline (`navigator.onLine === false`): a phone in a tunnel should resume,
 * not fail, when the network comes back. Driven by an external ticker so tests
 * control time.
 */
export class SendDeadlines {
    private items = new Map<string, { remaining: number; since: number }>();

    constructor(private readonly budgetMs: number = SEND_DEADLINE_MS) {}

    /** (Re)start the full budget, e.g. on first enqueue and on retry. */
    start(localIds: readonly string[], now: number): void {
        for (const localId of localIds) this.items.set(localId, { remaining: this.budgetMs, since: now });
    }

    delete(localId: string): void {
        this.items.delete(localId);
    }

    has(localId: string): boolean {
        return this.items.has(localId);
    }

    get size(): number {
        return this.items.size;
    }

    /** Charge elapsed time (only while online) and return the items that ran out. */
    tick(now: number, online: boolean): string[] {
        const expired: string[] = [];
        for (const [localId, item] of this.items) {
            if (online) item.remaining -= Math.max(0, now - item.since);
            item.since = now;
            if (item.remaining <= 0) expired.push(localId);
        }
        for (const localId of expired) this.items.delete(localId);
        return expired;
    }
}

/**
 * Drop the items the server acknowledged (by localId) from the pending queue,
 * in place. Not `splice(0, batch.length)`: a message enqueued, retried or
 * failed while the request was in flight must keep its own fate.
 */
export function removeByLocalId<T extends { localId: string }>(pending: T[], localIds: ReadonlySet<string>): void {
    let write = 0;
    for (const item of pending) {
        if (!localIds.has(item.localId)) pending[write++] = item;
    }
    pending.length = write;
}

/**
 * `sessionLastSeq` guards the live-update fast path: an update with
 * `seq <= lastSeq` is dropped as already reduced. An ack only proves OUR
 * messages exist, so jumping lastSeq to the ack's max seq would silently drop
 * an agent message stored in between (seq N+1 in flight, our ack says N+2).
 * Advance only through a contiguous run; a gap means history must be fetched.
 */
export function advanceLastSeq(current: number | undefined, seqs: readonly number[]): { next: number | undefined; gap: boolean } {
    // Before the initial page load there is no anchor; that load sets it.
    if (current === undefined) return { next: undefined, gap: false };
    const ahead = new Set(seqs.filter((seq) => seq > current));
    let next = current;
    while (ahead.has(next + 1)) {
        next += 1;
        ahead.delete(next);
    }
    return { next, gap: ahead.size > 0 };
}

/**
 * What a successful send response means locally. `trackedIds` are the batch's
 * user/file items as of dispatch (they must be confirmed from their ack, even
 * if their record was dropped meanwhile — a taken-back item must re-surface).
 * `lastSeq` may only move over seqs whose messages are reflected locally:
 * confirmed tracked items, and untracked batch items (tombstones, reduced when
 * enqueued). A seq we did not apply must not be skipped over, or its echo is
 * dropped as "already reduced" (review B-513).
 */
export function interpretSendResponse(
    stored: readonly { id: string; seq: number; localId: string | null }[],
    batchIds: ReadonlySet<string>,
    trackedIds: ReadonlySet<string>,
): {
    ackedIds: Set<string>;
    acks: { localId: string; seq: number; id: string }[];
    lastSeqCandidates: number[];
} {
    const ackedIds = new Set<string>();
    const acks: { localId: string; seq: number; id: string }[] = [];
    const lastSeqCandidates: number[] = [];
    for (const message of stored) {
        if (typeof message.localId !== 'string' || !batchIds.has(message.localId)) continue;
        ackedIds.add(message.localId);
        if (trackedIds.has(message.localId)) acks.push({ localId: message.localId, seq: message.seq, id: message.id });
        lastSeqCandidates.push(message.seq);
    }
    return { ackedIds, acks, lastSeqCandidates };
}

/**
 * Retry records (they hold the encrypted content) that are no longer needed:
 * the reducer shows no send state (confirmed — typically by an echo after a
 * deadline failure, which never produces an ack), no deadline is running and
 * the item is not queued. A `failed` item keeps its record for Retry.
 */
export function settledOutboxRecords(
    records: Iterable<{ localId: string; sessionId: string }>,
    sessionId: string,
    sendStates: ReadonlyMap<string, unknown>,
    isActive: (localId: string) => boolean,
): string[] {
    const settled: string[] = [];
    for (const record of records) {
        if (record.sessionId !== sessionId) continue;
        if (sendStates.has(record.localId) || isActive(record.localId)) continue;
        settled.push(record.localId);
    }
    return settled;
}

/**
 * Run `worker` over `items` with at most `limit` in flight; results keep input
 * order. Used for attachment uploads (B-513: capped at 3).
 */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const run = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await worker(items[index], index);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return results;
}
