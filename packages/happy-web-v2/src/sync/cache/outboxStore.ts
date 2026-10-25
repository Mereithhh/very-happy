/**
 * B-814 (spec B-807 §5.5, PR-6b): the persistent outbox — a write-through
 * mirror of this tab's unsent inputs in the account's `vh-sync-*` database
 * (the `outbox` store B-813 created), so a reload, a crash or a reclaimed
 * page does not lose them.
 *
 * `sync.ts` (`pendingOutbox` / `outboxRecords`) stays the runtime authority;
 * this only remembers. Only ciphertext is stored: `body` is the encrypted POST
 * content, byte for byte what a re-send carries (spec §5.5.1 lists a
 * plaintext `displayText`; it is left out — the bubble is rebuilt by
 * decrypting `body` once the session key is loaded, same as the cache, r2).
 *
 * Every failure means "not persisted", never a failed send: the caller sends
 * anyway, as before PR-6b.
 */
import { IdbTimeoutError, req, txDone, withTimeout } from './idb';

/** Owner 10-25: a takeover re-sends inputs at most this old; older ones wait for the user. */
export const OUTBOX_AUTO_RESEND_MS = 10 * 60_000;
/** Same budget as the message cache (§5.4.2): slower = stuck. */
const OUTBOX_OP_TIMEOUT_MS = 2_000;

/**
 * `queued`: not known to have reached the server — re-sent by whoever takes
 * it over within OUTBOX_AUTO_RESEND_MS. `failed`: shown as failed; only the
 * user re-sends it. A confirmed input is deleted on its ack (§5.5.2 `sent`
 * lasts no longer than that: the ack's seq is merged in the same step), so
 * `sending`/`sent` are never stored.
 */
export type OutboxRowState = 'queued' | 'failed';

export type OutboxRow = {
    /** Primary key; the server's idempotency key. */
    localId: string;
    sid: string;
    /** Encrypted record, exactly what POST /v3/sessions/:id/messages carries. */
    body: string;
    /** When it was sent — or last retried by the user (their consent restarts the clock). */
    createdAt: number;
    state: OutboxRowState;
    /** User retries so far. */
    attempts: number;
    lastError?: string;
    /** tabLiveness id of the tab that sends it. */
    ownerTabId: string;
    /** One user turn (attachments + text): retried together, in `order`. */
    group: string;
    order: number;
    /**
     * B-815: absent = a message POST (/v3/sessions/:id/messages); `queue` = a
     * prompt for the server prompt queue (B-509) the server has not accepted
     * yet — re-enqueued, never sent as a message. Same store, same takeover.
     */
    kind?: 'queue';
};

export type OutboxStoreDeps = {
    /**
     * The account's open database, or null (no IndexedDB / cache off / disabled).
     * `delete`: also while quota made the cache read-only — a delete frees space.
     */
    db: (purpose: 'write' | 'delete') => Promise<IDBDatabase | null>;
    now?: () => number;
};

/** Takeover: what the new owner does with each orphan (pure; spec §5.5.3). */
export function takeoverAction(row: Pick<OutboxRow, 'state' | 'createdAt'>, now: number): 'resend' | 'stale' {
    return row.state === 'queued' && now - row.createdAt <= OUTBOX_AUTO_RESEND_MS ? 'resend' : 'stale';
}

export function isOutboxRow(value: unknown): value is OutboxRow {
    const row = value as Partial<OutboxRow> | null;
    return !!row
        && typeof row.localId === 'string' && row.localId.length > 0
        && typeof row.sid === 'string' && row.sid.length > 0
        && typeof row.body === 'string' && row.body.length > 0
        && typeof row.createdAt === 'number' && Number.isFinite(row.createdAt)
        && (row.state === 'queued' || row.state === 'failed')
        && typeof row.ownerTabId === 'string'
        && typeof row.group === 'string'
        && typeof row.order === 'number'
        && (row.kind === undefined || row.kind === 'queue');
}

export class OutboxStore {
    private readonly deps: Required<OutboxStoreDeps>;
    /** Operations commit in call order (a put and the delete its ack triggers must not swap). */
    private chain: Promise<unknown> = Promise.resolve();
    private stuck = false;

    constructor(deps: OutboxStoreDeps) {
        this.deps = { now: Date.now, ...deps };
    }

    /** Write (or overwrite) rows. True when they are durable. */
    put(rows: readonly OutboxRow[]): Promise<boolean> {
        if (rows.length === 0) return Promise.resolve(true);
        return this.run('put', (store) => { for (const row of rows) store.put(row); }).then((ok) => ok !== null);
    }

    /**
     * Change stored rows in place. A localId with no row (it was never
     * persisted) gets `missing(localId)` instead, or is skipped on null.
     */
    update(localIds: readonly string[], change: (row: OutboxRow) => OutboxRow, missing?: (localId: string) => OutboxRow | null): Promise<void> {
        if (localIds.length === 0) return Promise.resolve();
        return this.run('update', async (store) => {
            for (const localId of localIds) {
                const row = await req<unknown>(store.get(localId));
                if (isOutboxRow(row)) store.put(change(row));
                else {
                    const created = missing?.(localId);
                    if (created) store.put(created);
                }
            }
        }).then(() => {});
    }

    remove(localIds: readonly string[]): Promise<void> {
        if (localIds.length === 0) return Promise.resolve();
        return this.run('delete', (store) => { for (const localId of localIds) store.delete(localId); }, 'delete').then(() => {});
    }

    /** Every row; malformed ones are deleted on the way. */
    all(): Promise<OutboxRow[]> {
        return this.run('read', async (store) => {
            const values = await req<unknown[]>(store.getAll());
            const rows: OutboxRow[] = [];
            for (const value of values) {
                if (isOutboxRow(value)) rows.push(value);
                else {
                    const key = (value as { localId?: unknown } | null)?.localId;
                    if (typeof key === 'string') store.delete(key);
                }
            }
            return rows;
        }).then((rows) => rows ?? []);
    }

    /**
     * §5.5.3: take over the rows whose owner tab is gone (this tab's previous
     * load included). Serialized across tabs by `withLock`, re-read inside it,
     * so exactly one tab takes each orphan. Rows too old to re-send on their
     * own become `failed` in the same write. Returns the rows now owned here.
     */
    async takeOver(
        tabId: string,
        isAlive: (tabId: string) => Promise<boolean>,
        withLock: (fn: () => Promise<void>) => Promise<void>,
    ): Promise<OutboxRow[]> {
        const peek = await this.all();
        if (!peek.some((row) => row.ownerTabId !== tabId)) return [];
        let taken: OutboxRow[] = [];
        await withLock(async () => {
            const rows = await this.all();
            const alive = new Map<string, boolean>();
            const orphans: OutboxRow[] = [];
            for (const row of rows) {
                if (row.ownerTabId === tabId) continue;
                let ownerAlive = alive.get(row.ownerTabId);
                if (ownerAlive === undefined) {
                    ownerAlive = row.ownerTabId.length > 0 && await isAlive(row.ownerTabId);
                    alive.set(row.ownerTabId, ownerAlive);
                }
                if (!ownerAlive) orphans.push(row);
            }
            if (orphans.length === 0) return;
            const now = this.deps.now();
            const claimed = orphans.map((row): OutboxRow => ({
                ...row,
                ownerTabId: tabId,
                state: takeoverAction(row, now) === 'resend' ? 'queued' : 'failed',
            }));
            // Not durably ours → not ours: another tab may take them next.
            if (await this.put(claimed)) taken = claimed;
        });
        return taken;
    }

    private run<T>(what: string, body: (store: IDBObjectStore) => T | Promise<T>, purpose: 'write' | 'delete' = 'write'): Promise<Awaited<T> | null> {
        const op = this.chain.then(async (): Promise<Awaited<T> | null> => {
            if (this.stuck) return null;
            const db = await this.deps.db(purpose).catch(() => null);
            if (!db) return null;
            try {
                return await withTimeout((async () => {
                    const tx = db.transaction('outbox', 'readwrite');
                    const done = txDone(tx);
                    try {
                        const result = await body(tx.objectStore('outbox'));
                        await done;
                        return result;
                    } catch (error) {
                        try { tx.abort(); } catch { /* already finished */ }
                        await done.catch(() => {});
                        throw error;
                    }
                })(), OUTBOX_OP_TIMEOUT_MS, `outbox ${what}`);
            } catch (error) {
                if (error instanceof IdbTimeoutError) this.stuck = true;
                console.warn(`[outbox] ${what} failed`, error);
                return null;
            }
        });
        this.chain = op.catch(() => {});
        return op;
    }
}
