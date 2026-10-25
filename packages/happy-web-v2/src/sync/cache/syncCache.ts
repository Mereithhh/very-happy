/**
 * B-813 (spec B-807 §5.4, PR-6a): the per-account IndexedDB message cache.
 *
 * What it holds: for each of the 30 most recently viewed sessions, the newest
 * ≤300 server rows exactly as the server sent them — `content` stays the
 * `{ t: 'encrypted', c }` ciphertext; nothing decrypted is ever written.
 * What it is for: a cold start or reload renders those rows at once and then
 * catches up from their lastSeq (sync.ts `fetchMessages`).
 *
 * It only ever changes speed, never what the transcript ends up showing:
 * every failure (open, schema, corrupt rows, quota, a stuck operation) turns
 * into "no cache for this session / this page" and the network path that
 * existed before runs instead (§5.4.2). Writes are fire-and-forget batches.
 */
import type { ApiMessage } from '@/sync/apiTypes';
import { accountFingerprint } from '@/sync/accountFingerprint';
import { deleteDatabase, IdbBlockedError, IdbTimeoutError, isQuotaError, openDatabase, req, txDone, withTimeout } from './idb';
import { pickEvictions, pickQuotaEvictions, type LruEntry } from './lru';
import { OutboxStore } from './outboxStore';
import {
    CACHE_MAX_MESSAGES,
    extendDownward,
    extendUpward,
    newestRows,
    sortUniqueBySeq,
    validateSegment,
    type CorruptReason,
} from './segment';

export const CACHE_DB_PREFIX = 'vh-sync-';
export const CACHE_SCHEMA = 1;
const DB_VERSION = 1;
export const OPEN_BLOCKED_MS = 3_000;
/** §5.4.2: any read or write slower than this = the cache is stuck; off for this page. */
export const CACHE_OP_TIMEOUT_MS = 2_000;
const FLUSH_DELAY_MS = 250;
const FLUSH_ROWS = 50;
const CLEANUP_EVERY_MS = 60_000;
/** A load never waits longer than this for the database to open — the network path is not held up. */
const LOAD_OPEN_WAIT_MS = 500;
/** B-814: an outbox write waits a little longer for the open (it is what survives a reload). */
const OUTBOX_OPEN_WAIT_MS = 1_500;
/** Rows above a hole wait in memory for it to fill; past this many they are given up (the run just stays shorter). */
const MAX_WAITING_ROWS = 100;
/**
 * Pushes for a session with no run yet wait only for its latest page, which
 * is already in flight (B-805 loads it on the first push) — keep few, since
 * any number of sessions can be in this state.
 */
const MAX_WAITING_ROWS_WITHOUT_RUN = 20;
/** Names of the databases this browser created — `indexedDB.databases()` is missing on older Safari. */
const REGISTRY_KEY = 'vh.sync.cache.dbs';
/** §6.1 `vh.sync.cache=off`: this browser only, never a synced setting (铁律 1). */
export const CACHE_SWITCH_KEY = 'vh.sync.cache';

/** One `messages` row: the server row, field by field, plus its session. */
export type StoredRow = {
    sid: string;
    id: string;
    seq: number;
    localId: string | null;
    content: { t: 'encrypted'; c: string };
    createdAt: number;
    updatedAt: number;
};

export type SessionRecord = {
    sid: string;
    lastSeq: number;
    oldestSeq: number;
    headSeqSeen: number;
    count: number;
    bytes: number;
    lastAccessAt: number;
    cachedAt: number;
};

type MetaRecord = { schema: number; accountHash: string; createdAt: number; lastCleanupAt: number; appBuild: string };

/**
 * `lastSeq` is where the covered run ends; it can be past the newest row (a
 * tail seq hole once PR-5b advances to the server head). `lastRowSeq` /
 * `lastId` are that newest row — what the server must still have.
 */
export type CacheHit = { rows: ApiMessage[]; oldestSeq: number; lastSeq: number; lastRowSeq: number; lastId: string };

export type DropReason = CorruptReason | 'decrypt' | 'behind' | 'mismatch' | 'deleted';

export type SyncCacheStats = {
    state: 'idle' | 'off' | 'opening' | 'ready' | 'disabled';
    /** Reads still work, writes stopped (QuotaExceeded twice). */
    readOnly: boolean;
    disabledReason: string | null;
    hits: number;
    misses: number;
    drops: Partial<Record<DropReason, number>>;
    flushes: number;
    writeErrors: number;
    quotaErrors: number;
    evicted: number;
    rebuilt: number;
};

type Pending = {
    drop: { outbox: boolean } | null;
    latest: StoredRow[] | null;
    /** Point rows (live pushes): extend the run only as lastSeq + 1. */
    newer: Map<number, StoredRow>;
    /** Range results (forward pages): every message in (afterSeq, max] (r1 §5.1 rule 3). */
    ranges: Array<{ afterSeq: number; rows: StoredRow[] }>;
    older: Array<{ beforeSeq: number; rows: StoredRow[] }>;
    touch: boolean;
};

type Waiting = { points: StoredRow[]; ranges: Array<{ afterSeq: number; rows: StoredRow[] }> };

const emptyPending = (): Pending => ({ drop: null, latest: null, newer: new Map(), ranges: [], older: [], touch: false });

export type SyncCacheDeps = {
    factory: () => IDBFactory | undefined;
    now?: () => number;
    localStorage?: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined;
    idle?: (fn: () => void) => void;
    appBuild?: string;
};

const messageRange = (sid: string) => IDBKeyRange.bound([sid, -Infinity], [sid, Infinity]);

/** The server row reduced to the fields the cache keeps; anything not ciphertext is refused. */
export function toStoredRow(sid: string, message: ApiMessage): StoredRow | null {
    const content = message?.content as { t?: unknown; c?: unknown } | undefined;
    if (!message || content?.t !== 'encrypted' || typeof content.c !== 'string') return null;
    if (typeof message.id !== 'string' || !Number.isInteger(message.seq)) return null;
    return {
        sid,
        id: message.id,
        seq: message.seq,
        localId: message.localId ?? null,
        content: { t: 'encrypted', c: content.c },
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
    };
}

function isStoredRow(sid: string, row: StoredRow): boolean {
    return !!row
        && row.sid === sid
        && typeof row.id === 'string'
        && Number.isInteger(row.seq)
        && (row.localId === null || typeof row.localId === 'string')
        && row.content?.t === 'encrypted'
        && typeof row.content.c === 'string'
        && typeof row.createdAt === 'number'
        && typeof row.updatedAt === 'number';
}

const rowBytes = (row: StoredRow) => row.content.c.length + row.id.length + 96;

function fromStoredRow(row: StoredRow): ApiMessage {
    return { id: row.id, seq: row.seq, localId: row.localId, content: row.content, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

async function accountHash(accountId: string): Promise<string> {
    try {
        const subtle = globalThis.crypto?.subtle;
        if (subtle) {
            const digest = await subtle.digest('SHA-256', new TextEncoder().encode(accountId));
            return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
        }
    } catch {
        // insecure context: fall through
    }
    return `f${accountFingerprint(accountId)}`;
}

function upgrade(db: IDBDatabase, tx: IDBTransaction, oldVersion: number, meta: MetaRecord) {
    if (oldVersion !== 0) throw new Error(`unknown cache version ${oldVersion}`);
    db.createObjectStore('meta');
    const sessions = db.createObjectStore('sessions', { keyPath: 'sid' });
    sessions.createIndex('lastAccessAt', 'lastAccessAt');
    db.createObjectStore('messages', { keyPath: ['sid', 'seq'] });
    // §5.5 (PR-6b) writes it; the LRU already never drops a session listed here.
    const outbox = db.createObjectStore('outbox', { keyPath: 'localId' });
    outbox.createIndex('sid', 'sid');
    outbox.createIndex('ownerTabId', 'ownerTabId');
    tx.objectStore('meta').put(meta, 'meta');
}

export class SyncCache {
    private readonly deps: Required<Omit<SyncCacheDeps, 'appBuild'>> & { appBuild: string };
    private dbPromise: Promise<IDBDatabase | null> | null = null;
    private db: IDBDatabase | null = null;
    private generation = 0;
    private pending = new Map<string, Pending>();
    private pendingRows = 0;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private flushChain: Promise<void> = Promise.resolve();
    private lastCleanupAt = 0;
    private readsEnabled = true;
    /** Sessions with a run in this database (null until it opened) — a miss costs no IndexedDB read. */
    private known: Set<string> | null = null;
    private openedKnown: Set<string> | null = null;
    private writesEnabled = true;
    private readonly counters: SyncCacheStats = {
        state: 'idle', readOnly: false, disabledReason: null, hits: 0, misses: 0, drops: {},
        flushes: 0, writeErrors: 0, quotaErrors: 0, evicted: 0, rebuilt: 0,
    };

    constructor(deps: SyncCacheDeps) {
        this.deps = {
            factory: deps.factory,
            now: deps.now ?? Date.now,
            localStorage: deps.localStorage ?? (() => { try { return globalThis.localStorage; } catch { return undefined; } }),
            idle: deps.idle ?? ((fn) => {
                const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback;
                if (ric) ric(fn, { timeout: 5_000 });
                else setTimeout(fn, 0);
            }),
            appBuild: deps.appBuild ?? 'web',
        };
    }

    /**
     * Synchronous: could `load(sid)` hit? False = skip straight to the
     * network, so a session without a cached run never waits on IndexedDB.
     */
    mayHave(sid: string): boolean {
        if (!this.readsEnabled || !this.dbPromise || this.pending.get(sid)?.drop) return false;
        return this.known === null || this.known.has(sid);
    }

    stats(): SyncCacheStats {
        return { ...this.counters, drops: { ...this.counters.drops }, readOnly: this.readsEnabled && !this.writesEnabled };
    }

    /** Open (or switch to) this account's database. Never throws; failure = no cache. */
    open(accountId: string): Promise<void> {
        const generation = ++this.generation;
        this.closeDb();
        this.pending.clear();
        this.pendingRows = 0;
        this.readsEnabled = true;
        this.writesEnabled = true;
        this.known = null;
        this.openedKnown = null;
        this.counters.disabledReason = null;
        if (this.switchedOff()) {
            this.counters.state = 'off';
            this.readsEnabled = false;
            this.writesEnabled = false;
            this.dbPromise = Promise.resolve(null);
            void clearSyncCaches(this.deps.factory(), this.deps.localStorage());
            return this.dbPromise.then(() => {});
        }
        this.counters.state = 'opening';
        this.dbPromise = this.openFor(accountId).then((db) => {
            if (generation !== this.generation) { db?.close(); return null; }
            this.db = db;
            this.known = this.openedKnown;
            if (db) {
                this.counters.state = 'ready';
                this.scheduleCleanup();
            }
            return db;
        }, (error) => {
            if (generation === this.generation) this.disable(`open: ${describe(error)}`);
            return null;
        });
        return this.dbPromise.then(() => {});
    }

    /**
     * §5.4: the cached run of `sid`, validated; null on a miss or any problem.
     * `viewed`: the user opened it — it counts as recently viewed for the LRU.
     */
    async load(sid: string, opts: { viewed?: boolean } = {}): Promise<CacheHit | null> {
        if (!this.mayHave(sid)) return this.miss();
        const db = await this.readyDb();
        if (!db || !this.readsEnabled || this.pending.get(sid)?.drop) return this.miss();
        let record: SessionRecord | undefined;
        let rows: StoredRow[];
        let counts: { inRange: number; total: number };
        try {
            ({ record, rows, counts } = await withTimeout(this.readSession(db, sid), CACHE_OP_TIMEOUT_MS, 'read'));
        } catch (error) {
            if (error instanceof IdbTimeoutError) this.disable('stuck read');
            return this.miss();
        }
        if (!record) return this.miss();
        const verdict = validateSegment(record, rows, (row) => isStoredRow(sid, row), counts);
        if (!verdict.ok) {
            this.dropSession(sid, verdict.reason);
            return this.miss();
        }
        this.counters.hits += 1;
        if (opts.viewed) {
            this.entry(sid).touch = true;
            this.scheduleFlush();
        }
        const last = rows[rows.length - 1];
        return { rows: rows.map(fromStoredRow), oldestSeq: rows[0].seq, lastSeq: record.lastSeq, lastRowSeq: last.seq, lastId: last.id };
    }

    /**
     * A latest page (cold open, gapTooLarge): the session's run restarts from
     * it. A page loaded for a session nobody opened (B-805 board previews)
     * does not count as viewed — it is the first to go.
     */
    offerLatest(sid: string, messages: readonly ApiMessage[], opts: { viewed?: boolean } = {}) {
        const rows = this.storedRows(sid, messages);
        if (rows === null) return;
        const entry = this.entry(sid);
        entry.latest = newestRows(rows);
        entry.older = [];
        entry.touch = entry.touch || !!opts.viewed;
        const top = entry.latest.at(-1)?.seq ?? 0;
        for (const seq of [...entry.newer.keys()]) if (seq <= top) entry.newer.delete(seq);
        entry.ranges = entry.ranges.filter((range) => range.rows.some((row) => row.seq > top));
        this.scheduleFlush(rows.length);
    }

    /**
     * A forward page asked with `after_seq = afterSeq` (a range result: every
     * message in (afterSeq, max], seq holes included), or live pushes when
     * `afterSeq` is omitted (point rows: only lastSeq + 1 extends the run).
     * Rows that do not reach the run yet wait in memory.
     */
    offerNewer(sid: string, messages: readonly ApiMessage[], range?: { afterSeq: number }) {
        const rows = this.storedRows(sid, messages);
        if (rows === null || rows.length === 0) return;
        const entry = this.entry(sid);
        if (range) {
            entry.ranges.push({ afterSeq: range.afterSeq, rows });
            if (entry.ranges.reduce((n, r) => n + r.rows.length, 0) > MAX_WAITING_ROWS * 3) entry.ranges.shift();
        } else {
            for (const row of rows) entry.newer.set(row.seq, row);
            if (entry.newer.size > MAX_WAITING_ROWS) entry.newer.clear();
        }
        this.scheduleFlush(rows.length);
    }

    /** An older page asked with `before_seq = beforeSeq`: extends the run downward while it holds fewer than 300 rows. */
    offerOlder(sid: string, messages: readonly ApiMessage[], range: { beforeSeq: number }) {
        const rows = this.storedRows(sid, messages);
        if (rows === null || rows.length === 0) return;
        this.entry(sid).older.push({ beforeSeq: range.beforeSeq, rows });
        this.scheduleFlush(rows.length);
    }

    /** §5.4.2: forget one session's cache (corrupt, behind the server, deleted). */
    dropSession(sid: string, reason: DropReason) {
        this.counters.drops[reason] = (this.counters.drops[reason] ?? 0) + 1;
        if (!this.writesEnabled && !this.readsEnabled) return;
        this.pending.set(sid, { ...emptyPending(), drop: { outbox: reason === 'deleted' } });
        this.scheduleFlush(FLUSH_ROWS);
    }

    /** Write everything buffered now (tests, page hide). */
    flush(): Promise<void> {
        if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
        this.flushChain = this.flushChain.then(() => this.flushOnce()).catch(() => {});
        return this.flushChain;
    }

    /** Close the connection and forget buffered writes (logout, account switch). */
    close() {
        this.generation += 1;
        this.closeDb();
        this.pending.clear();
        this.pendingRows = 0;
        this.counters.state = 'idle';
        this.dbPromise = null;
    }

    /** Test/e2e hook: run the LRU pass now. */
    async cleanupNow(): Promise<void> {
        const db = await this.readyDb();
        if (db && this.writesEnabled) await this.cleanup(db, 'lru');
    }

    // ── internals ────────────────────────────────────────────────────

    private miss(): null {
        this.counters.misses += 1;
        return null;
    }

    private switchedOff(): boolean {
        try { return this.deps.localStorage()?.getItem(CACHE_SWITCH_KEY) === 'off'; } catch { return false; }
    }

    private disable(reason: string) {
        this.readsEnabled = false;
        this.writesEnabled = false;
        this.counters.state = 'disabled';
        this.counters.disabledReason = reason;
        this.pending.clear();
        this.pendingRows = 0;
        this.closeDb();
    }

    private closeDb() {
        if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
        try { this.db?.close(); } catch { /* already closed */ }
        this.db = null;
    }

    /**
     * B-814: the same database for the persistent outbox (outboxStore.ts) —
     * null while writes are off (switched off, disabled, read-only on quota).
     */
    outboxDatabase(waitMs = LOAD_OPEN_WAIT_MS): Promise<IDBDatabase | null> {
        if (!this.writesEnabled) return Promise.resolve(null);
        return this.readyDb(waitMs);
    }

    private async readyDb(waitMs = LOAD_OPEN_WAIT_MS): Promise<IDBDatabase | null> {
        if (!this.dbPromise) return null;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const db = await Promise.race([
            this.dbPromise,
            new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs); }),
        ]);
        if (timer) clearTimeout(timer);
        return db && this.db === db ? db : null;
    }

    private entry(sid: string): Pending {
        let entry = this.pending.get(sid);
        if (!entry) {
            entry = emptyPending();
            this.pending.set(sid, entry);
        }
        return entry;
    }

    private storedRows(sid: string, messages: readonly ApiMessage[]): StoredRow[] | null {
        if (!this.writesEnabled || !this.dbPromise) return null;
        const rows: StoredRow[] = [];
        for (const message of messages) {
            const row = toStoredRow(sid, message);
            if (row) rows.push(row);
        }
        return rows;
    }

    private scheduleFlush(rows = 0) {
        if (!this.writesEnabled) return;
        this.pendingRows += rows;
        if (this.pendingRows >= FLUSH_ROWS) {
            void this.flush();
            return;
        }
        this.flushTimer ??= setTimeout(() => { this.flushTimer = null; void this.flush(); }, FLUSH_DELAY_MS);
    }

    private async openFor(accountId: string): Promise<IDBDatabase | null> {
        const factory = this.deps.factory();
        if (!factory) throw new Error('no indexedDB');
        const hash = await accountHash(accountId);
        const name = `${CACHE_DB_PREFIX}${hash}`;
        this.register(name);
        const freshMeta = (): MetaRecord => ({ schema: CACHE_SCHEMA, accountHash: hash, createdAt: this.deps.now(), lastCleanupAt: 0, appBuild: this.deps.appBuild });
        const openOnce = () => openDatabase(factory, name, DB_VERSION, (db, tx, oldVersion) => upgrade(db, tx, oldVersion, freshMeta()), OPEN_BLOCKED_MS);
        let db: IDBDatabase;
        try {
            db = await openOnce();
        } catch (error) {
            // §5.4.2 row 1: blocked by another tab / private mode → no cache.
            if (error instanceof IdbBlockedError || !isRebuildable(error)) throw error;
            // §5.4.2 row 2: a version or upgrade we cannot use → rebuild once.
            return this.rebuild(factory, name, openOnce);
        }
        let meta: MetaRecord | undefined;
        try {
            meta = await withTimeout(readMeta(db), CACHE_OP_TIMEOUT_MS, 'read meta');
        } catch (error) {
            if (error instanceof IdbTimeoutError) { db.close(); throw error; }
            meta = undefined;
        }
        if (!meta || meta.schema !== CACHE_SCHEMA || meta.accountHash !== hash || !hasStores(db)) {
            db.close();
            return this.rebuild(factory, name, openOnce);
        }
        this.lastCleanupAt = meta.lastCleanupAt ?? 0;
        this.openedKnown = await withTimeout(readKnown(db), CACHE_OP_TIMEOUT_MS, 'read sessions').catch(() => null);
        return db;
    }

    private async rebuild(factory: IDBFactory, name: string, openOnce: () => Promise<IDBDatabase>): Promise<IDBDatabase> {
        this.counters.rebuilt += 1;
        await deleteDatabase(factory, name, OPEN_BLOCKED_MS);
        const db = await openOnce();
        const meta = await withTimeout(readMeta(db), CACHE_OP_TIMEOUT_MS, 'read meta').catch(() => undefined);
        if (!meta || meta.schema !== CACHE_SCHEMA || !hasStores(db)) {
            db.close();
            throw new Error('rebuilt cache has no usable schema');
        }
        this.openedKnown = new Set();
        return db;
    }

    private register(name: string) {
        try {
            const storage = this.deps.localStorage();
            if (!storage) return;
            const names = new Set(parseRegistry(storage.getItem(REGISTRY_KEY)));
            if (names.has(name)) return;
            names.add(name);
            storage.setItem(REGISTRY_KEY, JSON.stringify([...names]));
        } catch { /* storage full or blocked: logout still finds it via databases() */ }
    }

    /** r1 §5.4: the newest 300 rows of `[oldestSeq, lastSeq]` through a `prev` cursor (seq holes make a seq window short). */
    private async readSession(db: IDBDatabase, sid: string): Promise<{ record: SessionRecord | undefined; rows: StoredRow[]; counts: { inRange: number; total: number } }> {
        const tx = db.transaction(['sessions', 'messages'], 'readonly');
        const done = txDone(tx);
        const record = await req<SessionRecord | undefined>(tx.objectStore('sessions').get(sid));
        let rows: StoredRow[] = [];
        const counts = { inRange: 0, total: 0 };
        if (record && Number.isInteger(record.lastSeq) && Number.isInteger(record.oldestSeq) && record.oldestSeq >= 1 && record.oldestSeq <= record.lastSeq) {
            const store = tx.objectStore('messages');
            const range = IDBKeyRange.bound([sid, record.oldestSeq], [sid, record.lastSeq]);
            rows = (await readNewest<StoredRow>(store, range, CACHE_MAX_MESSAGES)).reverse();
            counts.inRange = await req(store.count(range));
            counts.total = await req(store.count(messageRange(sid)));
        }
        await done;
        return { record, rows, counts };
    }

    private async flushOnce(): Promise<void> {
        if (!this.writesEnabled || this.pending.size === 0) return;
        const db = this.db ?? await this.readyDb();
        if (!db || !this.writesEnabled) return;
        const batch = this.pending;
        this.pending = new Map();
        this.pendingRows = 0;
        this.counters.flushes += 1;
        let waiting: Map<string, Waiting>;
        try {
            waiting = await this.writeWithTimeout(db, batch);
        } catch (error) {
            if (error instanceof IdbTimeoutError) { this.disable('stuck write'); return; }
            if (!isQuotaError(error)) { this.counters.writeErrors += 1; return; }
            // §5.4.1: QuotaExceeded → drop the older half, retry once; then read-only for this page.
            this.counters.quotaErrors += 1;
            try {
                await withTimeout(this.cleanup(db, 'quota'), CACHE_OP_TIMEOUT_MS, 'quota eviction');
                waiting = await this.writeWithTimeout(db, batch);
            } catch (retryError) {
                if (retryError instanceof IdbTimeoutError) { this.disable('stuck write'); return; }
                if (isQuotaError(retryError)) this.counters.quotaErrors += 1;
                this.writesEnabled = false;
                this.pending.clear();
                return;
            }
        }
        for (const [sid, rest] of waiting) {
            if (rest.points.length === 0 && rest.ranges.length === 0) continue;
            const entry = this.entry(sid);
            if (entry.drop || entry.latest) continue;
            for (const row of rest.points) if (!entry.newer.has(row.seq)) entry.newer.set(row.seq, row);
            entry.ranges.unshift(...rest.ranges);
        }
        if (this.deps.now() - this.lastCleanupAt > CLEANUP_EVERY_MS) this.scheduleCleanup();
    }

    private writeWithTimeout(db: IDBDatabase, batch: Map<string, Pending>) {
        return withTimeout(this.writeBatch(db, batch), CACHE_OP_TIMEOUT_MS, 'write');
    }

    /** One readwrite transaction for the whole batch; returns rows still waiting above a hole. */
    private async writeBatch(db: IDBDatabase, batch: Map<string, Pending>): Promise<Map<string, Waiting>> {
        const tx = db.transaction(['sessions', 'messages', 'outbox'], 'readwrite');
        const done = txDone(tx);
        const sessions = tx.objectStore('sessions');
        const messages = tx.objectStore('messages');
        const waiting = new Map<string, Waiting>();
        const now = this.deps.now();
        try {
            for (const [sid, entry] of batch) {
                let record: SessionRecord | undefined;
                let dirty = false;
                if (entry.drop) {
                    this.known?.delete(sid);
                    messages.delete(messageRange(sid));
                    sessions.delete(sid);
                    if (entry.drop.outbox) {
                        const keys = await req(tx.objectStore('outbox').index('sid').getAllKeys(sid));
                        for (const key of keys) tx.objectStore('outbox').delete(key);
                    }
                } else {
                    record = await req<SessionRecord | undefined>(sessions.get(sid));
                }
                if (entry.latest && entry.latest.length > 0) {
                    if (record) messages.delete(messageRange(sid));
                    for (const row of entry.latest) messages.put(row);
                    const first = entry.latest[0];
                    const last = entry.latest[entry.latest.length - 1];
                    record = {
                        sid, oldestSeq: first.seq, lastSeq: last.seq, headSeqSeen: last.seq, count: entry.latest.length,
                        bytes: entry.latest.reduce((total, row) => total + rowBytes(row), 0),
                        lastAccessAt: record?.lastAccessAt ?? 0, cachedAt: now,
                    };
                    dirty = true;
                }
                if (record && (entry.newer.size > 0 || entry.ranges.length > 0)) {
                    const up = extendUpward(record.lastSeq, [...entry.newer.values()], entry.ranges);
                    for (const row of up.append) messages.put(row);
                    if (up.cover > record.lastSeq) {
                        record.lastSeq = up.cover;
                        record.headSeqSeen = Math.max(record.headSeqSeen, record.lastSeq);
                        record.count += up.append.length;
                        record.bytes += up.append.reduce((total, row) => total + rowBytes(row), 0);
                        record.cachedAt = now;
                        dirty = true;
                    }
                    if (up.waiting.length > 0 || up.waitingRanges.length > 0) waiting.set(sid, { points: up.waiting, ranges: up.waitingRanges });
                } else if (!record && (entry.newer.size > 0 || entry.ranges.length > 0)) {
                    // No run yet: rows wait for this session's latest page.
                    waiting.set(sid, {
                        points: sortUniqueBySeq([...entry.newer.values()]).slice(-MAX_WAITING_ROWS_WITHOUT_RUN),
                        ranges: entry.ranges.slice(-1),
                    });
                }
                if (record) {
                    for (const older of entry.older) {
                        const prepend = extendDownward(record.oldestSeq, older.rows, older.beforeSeq, CACHE_MAX_MESSAGES - record.count);
                        for (const row of prepend) messages.put(row);
                        if (prepend.length > 0) {
                            record.oldestSeq = prepend[0].seq;
                            record.count += prepend.length;
                            record.bytes += prepend.reduce((total, row) => total + rowBytes(row), 0);
                            dirty = true;
                        }
                    }
                }
                if (record && record.count > CACHE_MAX_MESSAGES) {
                    // r1 §5.4.1: keep the newest 300 ROWS (not a seq window); oldestSeq = the oldest kept row.
                    const range = IDBKeyRange.bound([sid, record.oldestSeq], [sid, record.lastSeq]);
                    const keep = await readNewestKeys(messages, range, CACHE_MAX_MESSAGES);
                    const floor = keep[keep.length - 1];
                    if (floor !== undefined && floor > record.oldestSeq) {
                        messages.delete(IDBKeyRange.bound([sid, record.oldestSeq], [sid, floor], false, true));
                        record.bytes = Math.max(0, Math.round(record.bytes * (keep.length / record.count)));
                        record.oldestSeq = floor;
                    }
                    record.count = keep.length;
                    dirty = true;
                }
                if (record && entry.touch) {
                    record.lastAccessAt = now;
                    dirty = true;
                }
                if (record && dirty) {
                    sessions.put(record);
                    this.known?.add(sid);
                }
            }
        } catch (error) {
            try { tx.abort(); } catch { /* already finished */ }
            await done.catch(() => {});
            throw tx.error ?? error;
        }
        await done;
        return waiting;
    }

    /** §5.4.1: on open, then after a flush at most once a minute, in idle time. */
    private scheduleCleanup() {
        this.lastCleanupAt = this.deps.now();
        this.deps.idle(() => {
            const db = this.db;
            if (!db || !this.writesEnabled) return;
            void withTimeout(this.cleanup(db, 'lru'), CACHE_OP_TIMEOUT_MS, 'cleanup').catch((error) => {
                if (error instanceof IdbTimeoutError) this.disable('stuck cleanup');
            });
        });
    }

    /** §5.4.1: drop least recently viewed sessions over the limits (or half of them on quota). */
    private async cleanup(db: IDBDatabase, mode: 'lru' | 'quota'): Promise<void> {
        const read = db.transaction(['sessions', 'outbox'], 'readonly');
        const readDone = txDone(read);
        const records = await req<SessionRecord[]>(read.objectStore('sessions').getAll());
        const outboxSids = new Set((await req<Array<{ sid?: string }>>(read.objectStore('outbox').getAll())).map((row) => row.sid));
        await readDone;
        const entries: LruEntry[] = records.map((record) => ({ sid: record.sid, lastAccessAt: record.lastAccessAt, bytes: record.bytes }));
        const isProtected = (sid: string) => outboxSids.has(sid);
        const evict = mode === 'quota' ? pickQuotaEvictions(entries, isProtected) : pickEvictions(entries, isProtected);
        if (evict.length > 0) {
            const write = db.transaction(['sessions', 'messages'], 'readwrite');
            const writeDone = txDone(write);
            for (const sid of evict) {
                write.objectStore('messages').delete(messageRange(sid));
                write.objectStore('sessions').delete(sid);
                this.known?.delete(sid);
            }
            await writeDone;
            this.counters.evicted += evict.length;
        }
        // Bookkeeping only (a full disk may refuse it): the evictions above stand either way.
        try {
            const metaTx = db.transaction('meta', 'readwrite');
            const metaDone = txDone(metaTx);
            const meta = await req<MetaRecord | undefined>(metaTx.objectStore('meta').get('meta'));
            if (meta) metaTx.objectStore('meta').put({ ...meta, lastCleanupAt: this.deps.now() }, 'meta');
            await metaDone;
        } catch { /* ignore */ }
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** VersionError (a newer build's database) and upgrade failures are rebuilt; everything else means no cache. */
function isRebuildable(error: unknown): boolean {
    const name = (error as { name?: unknown } | null)?.name;
    return name === 'VersionError' || (error instanceof Error && /unknown cache version/.test(error.message));
}

function hasStores(db: IDBDatabase): boolean {
    const names = db.objectStoreNames;
    return names.contains('meta') && names.contains('sessions') && names.contains('messages') && names.contains('outbox');
}

/** The newest `limit` values of `range`, newest first. */
function readNewest<T>(store: IDBObjectStore, range: IDBKeyRange, limit: number): Promise<T[]> {
    return new Promise<T[]>((resolve, reject) => {
        const out: T[] = [];
        const request = store.openCursor(range, 'prev');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor || out.length >= limit) { resolve(out); return; }
            out.push(cursor.value as T);
            cursor.continue();
        };
    });
}

/** The seqs of the newest `limit` rows of `range`, newest first. */
function readNewestKeys(store: IDBObjectStore, range: IDBKeyRange, limit: number): Promise<number[]> {
    return new Promise<number[]>((resolve, reject) => {
        const out: number[] = [];
        const request = store.openKeyCursor(range, 'prev');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor || out.length >= limit) { resolve(out); return; }
            out.push((cursor.primaryKey as [string, number])[1]);
            cursor.continue();
        };
    });
}

async function readKnown(db: IDBDatabase): Promise<Set<string>> {
    const tx = db.transaction('sessions', 'readonly');
    const done = txDone(tx);
    const keys = await req<IDBValidKey[]>(tx.objectStore('sessions').getAllKeys());
    await done;
    return new Set(keys.filter((key): key is string => typeof key === 'string'));
}

async function readMeta(db: IDBDatabase): Promise<MetaRecord | undefined> {
    if (!db.objectStoreNames.contains('meta')) return undefined;
    const tx = db.transaction('meta', 'readonly');
    const done = txDone(tx);
    const meta = await req<MetaRecord | undefined>(tx.objectStore('meta').get('meta'));
    await done;
    return meta;
}

function parseRegistry(raw: string | null): string[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === 'string' && name.startsWith(CACHE_DB_PREFIX)) : [];
    } catch {
        return [];
    }
}

/**
 * Logout (Owner 10-25: 退出登录时全部清空) and `vh.sync.cache=off`: delete
 * every `vh-sync-*` database this browser has. Best effort, never throws.
 */
export async function clearSyncCaches(
    factory: IDBFactory | undefined,
    storage: Pick<Storage, 'getItem' | 'removeItem'> | undefined,
): Promise<string[]> {
    if (!factory) return [];
    const names = new Set<string>();
    try { for (const name of parseRegistry(storage?.getItem(REGISTRY_KEY) ?? null)) names.add(name); } catch { /* ignore */ }
    try {
        const listed = await factory.databases?.();
        for (const db of listed ?? []) if (db.name?.startsWith(CACHE_DB_PREFIX)) names.add(db.name);
    } catch { /* Safari < 14 has no databases() — the registry covers it */ }
    const deleted: string[] = [];
    await Promise.all([...names].map(async (name) => {
        try {
            await deleteDatabase(factory, name, OPEN_BLOCKED_MS);
            deleted.push(name);
        } catch { /* blocked: the next open of that account finds it intact, logout already dropped the key */ }
    }));
    try { storage?.removeItem(REGISTRY_KEY); } catch { /* ignore */ }
    return deleted;
}

export function hasIndexedDb(): IDBFactory | undefined {
    try {
        return typeof indexedDB === 'undefined' ? undefined : indexedDB;
    } catch {
        return undefined;
    }
}

/** The app's cache (one per tab). */
export const syncCache = new SyncCache({ factory: hasIndexedDb });

/** B-814: the app's persistent outbox, in the cache's database (opened with it, cleared with it). */
export const outboxStore = new OutboxStore({ db: () => syncCache.outboxDatabase(OUTBOX_OPEN_WAIT_MS) });

/** Logout: close this tab's connection first so the delete is not blocked by it. */
export async function clearSyncCacheOnLogout(): Promise<void> {
    syncCache.close();
    let storage: Storage | undefined;
    try { storage = globalThis.localStorage; } catch { storage = undefined; }
    await clearSyncCaches(hasIndexedDb(), storage);
}
