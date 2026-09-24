import { createAdapter } from '@socket.io/redis-streams-adapter';
import type { Redis } from 'ioredis';

/**
 * B-494: socket.io Redis streams adapter with bounded connection-state recovery.
 *
 * Incident (2026-09-25): a Caddy reload reconnected ~250 clients at once. The
 * stock adapter's `restoreSession` runs `XRANGE <client offset> +` with no
 * COUNT, so every client pulled the whole tail of a 200k-entry stream in one
 * reply. All of that went through the single adapter connection, whose output
 * buffer grew to ~4 GB until ElastiCache reset it; the XADDs queued on the same
 * connection stalled, so the stream head froze and live pushes stopped for 25
 * minutes.
 *
 * Three independent guards, none of which fork the adapter:
 *  1. `SOCKET_STREAM_MAX_LEN` keeps a few minutes of stream (XADD uses the
 *     adapter's `MAXLEN ~`, i.e. whole-node approximate trimming).
 *  2. `restoreSession` is replaced by `boundedRestoreSession`: an offset older
 *     than the recovery window, missing from the stream, or needing more than
 *     `maxScanEntries` entries gives up. Giving up is the documented
 *     `recovered === false` path — Web and CLI then do their full seq-based
 *     resync, so nothing is lost; it only costs a refetch.
 *  3. The adapter sees a facade that routes XADD/SET/MULTI (publish), XREAD
 *     (the blocking poll loop) and XRANGE (recovery reads) to three different
 *     connections, so a slow recovery read can never delay a publish again.
 */

export const SOCKET_STREAM_MAX_LEN = 20_000;

export type RecoveryOutcome =
    | 'recovered'
    | 'invalid_offset'
    | 'offset_too_old'
    | 'busy'
    | 'session_missing'
    | 'offset_missing'
    | 'scan_limit'
    | 'timeout'
    | 'error';

export interface RecoveryLimits {
    /** Offset older than this (relative to now) is not worth scanning. */
    maxOffsetAgeMs: number;
    /** Give up when the missed range is longer than this many stream entries. */
    maxScanEntries: number;
    /** XRANGE COUNT per page; bounds a single Redis reply. */
    pageSize: number;
    /** Restores running at once; the rest wait up to `queueTimeoutMs`. */
    maxConcurrent: number;
    queueTimeoutMs: number;
    /** Whole restore (after admission) must finish within this, or give up. */
    deadlineMs: number;
}

export function defaultRecoveryLimits(maxDisconnectionDurationMs: number): RecoveryLimits {
    return {
        // The offset is the last packet the client received, so it is at least
        // the disconnect duration old; allow another window of idle time
        // before the disconnect (~60 s ≈ 5.5k entries at the observed ~90/s).
        maxOffsetAgeMs: maxDisconnectionDurationMs * 2,
        maxScanEntries: 10_000,
        pageSize: 500,
        maxConcurrent: 16,
        queueTimeoutMs: 3_000,
        deadlineMs: 5_000,
    };
}

export interface RecoveryObserver {
    onOutcome?(outcome: RecoveryOutcome, scannedEntries: number): void;
}

type StreamEntry = [id: string, fields: string[]];

interface RestoreClient {
    xrange(key: string, start: string, end: string, count: 'COUNT', n: number): Promise<StreamEntry[]>;
}

interface PublishClient {
    multi(): { get(key: string): any; del(key: string): any; exec(): Promise<any> };
}

interface AdapterLike {
    nsp: { name: string };
    constructor: { decode(raw: Record<string, string>): any };
    restoreSession(pid: string, offset: string): Promise<any>;
}

const OFFSET_RE = /^([0-9]+)-([0-9]+)$/;

/** Same exclusive-start trick as the stock adapter (works before Redis 6.2). */
export function nextStreamOffset(offset: string): string {
    const [ms, seq] = offset.split('-');
    return `${ms}-${Number.parseInt(seq, 10) + 1}`;
}

function fieldsToObject(fields: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (let i = 0; i + 1 < fields.length; i += 2) out[fields[i]] = fields[i + 1];
    return out;
}

function shouldIncludePacket(sessionRooms: string[], opts: { rooms: string[]; except: string[] }): boolean {
    const included = opts.rooms.length === 0 || sessionRooms.some((room) => opts.rooms.indexOf(room) !== -1);
    const notExcluded = sessionRooms.every((room) => opts.except.indexOf(room) === -1);
    return included && notExcluded;
}

class RecoveryRejected extends Error {
    constructor(readonly outcome: RecoveryOutcome, readonly scanned = 0) {
        super(`connection state recovery skipped: ${outcome}`);
    }
}

/** Counting semaphore with a bounded wait; `acquire` resolves false on timeout. */
export class RecoveryGate {
    private active = 0;
    private readonly waiters: Array<() => void> = [];

    constructor(private readonly max: number, private readonly timeoutMs: number) {}

    get inFlight(): number {
        return this.active;
    }

    acquire(): Promise<boolean> {
        if (this.active < this.max) {
            this.active++;
            return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
            const grant = () => {
                clearTimeout(timer);
                this.active++;
                resolve(true);
            };
            const timer = setTimeout(() => {
                const index = this.waiters.indexOf(grant);
                if (index !== -1) this.waiters.splice(index, 1);
                resolve(false);
            }, this.timeoutMs);
            this.waiters.push(grant);
        });
    }

    release(): void {
        this.active--;
        const next = this.waiters.shift();
        if (next) next();
    }
}

export interface BoundedRestoreDeps {
    publish: PublishClient;
    restore: RestoreClient;
    streamName: string;
    sessionKeyPrefix: string;
    limits: RecoveryLimits;
    gate: RecoveryGate;
    decodeSession(raw: string): any;
    now?: () => number;
    observer?: RecoveryObserver;
}

/**
 * Drop-in replacement for RedisStreamsAdapter#restoreSession with the B-494
 * bounds. Resolves the restored session or rejects; socket.io treats a
 * rejection as "not recovered" and creates a fresh session.
 */
export async function boundedRestoreSession(
    adapter: Pick<AdapterLike, 'nsp' | 'constructor'>,
    deps: BoundedRestoreDeps,
    pid: string,
    offset: string,
): Promise<any> {
    const now = deps.now ?? Date.now;
    const state = { scanned: 0, abandoned: false };
    try {
        const match = OFFSET_RE.exec(offset);
        if (!match) throw new RecoveryRejected('invalid_offset');
        if (now() - Number(match[1]) > deps.limits.maxOffsetAgeMs) throw new RecoveryRejected('offset_too_old');
        if (!(await deps.gate.acquire())) throw new RecoveryRejected('busy');

        // The slot is released when the work itself settles, even if the
        // deadline gave up first, so a hung connection cannot leak slots; an
        // abandoned scan stops at its next page.
        const work = scanMissedPackets(adapter, deps, pid, offset, state).finally(() => deps.gate.release());
        work.catch(() => { /* observed through the race below */ });
        let timer: NodeJS.Timeout | undefined;
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                state.abandoned = true;
                reject(new RecoveryRejected('timeout', state.scanned));
            }, deps.limits.deadlineMs);
        });
        try {
            const session = await Promise.race([work, deadline]);
            deps.observer?.onOutcome?.('recovered', state.scanned);
            return session;
        } finally {
            clearTimeout(timer);
        }
    } catch (error) {
        const outcome: RecoveryOutcome = error instanceof RecoveryRejected ? error.outcome : 'error';
        deps.observer?.onOutcome?.(outcome, state.scanned);
        throw error;
    }
}

async function scanMissedPackets(
    adapter: Pick<AdapterLike, 'nsp' | 'constructor'>,
    deps: BoundedRestoreDeps,
    pid: string,
    offset: string,
    state: { scanned: number; abandoned: boolean },
): Promise<any> {
    const sessionKey = deps.sessionKeyPrefix + pid;
    const [sessionResult, offsetEntries] = await Promise.all([
        deps.publish.multi().get(sessionKey).del(sessionKey).exec(),
        deps.restore.xrange(deps.streamName, offset, offset, 'COUNT', 1),
    ]);
    const rawSession: string | null = sessionResult?.[0]?.[1] ?? null;
    if (!rawSession) throw new RecoveryRejected('session_missing');
    if (offsetEntries.length === 0) throw new RecoveryRejected('offset_missing');

    const session = deps.decodeSession(rawSession);
    session.missedPackets = [];
    const decode = adapter.constructor.decode;
    let cursor = offset;
    for (;;) {
        if (state.abandoned) throw new RecoveryRejected('timeout', state.scanned);
        const page = await deps.restore.xrange(
            deps.streamName, nextStreamOffset(cursor), '+', 'COUNT', deps.limits.pageSize,
        );
        state.scanned += page.length;
        if (state.scanned > deps.limits.maxScanEntries) throw new RecoveryRejected('scan_limit', state.scanned);
        for (const [id, fields] of page) {
            const raw = fieldsToObject(fields);
            if (raw.nsp === adapter.nsp.name && raw.type === '3') {
                const { packet, opts } = decode(raw).data;
                if (shouldIncludePacket(session.rooms, opts)) {
                    packet.data.push(id);
                    session.missedPackets.push(packet.data);
                }
            }
            cursor = id;
        }
        if (page.length < deps.limits.pageSize) return session;
    }
}

export interface AdapterConnections {
    /** XADD, SET (session persist), MULTI/GETDEL. Never blocked by reads. */
    publish: Redis;
    /** The adapter's `XREAD BLOCK` poll loop. */
    poll: Redis;
    /** Recovery XRANGE pages. */
    restore: Redis;
}

/**
 * Object the stock adapter receives as its "redis client". It uses exactly
 * xadd / xread / xrange / set / multi (adapter 0.2.3, dist/util.js); each is
 * routed to its own connection. Any other method is deliberately absent so an
 * adapter upgrade that starts using one fails loudly in tests.
 */
export function createAdapterClientFacade(connections: AdapterConnections) {
    const { publish, poll, restore } = connections;
    return {
        xadd: (...args: any[]) => (publish.xadd as any)(...args),
        set: (...args: any[]) => (publish.set as any)(...args),
        multi: () => publish.multi(),
        xread: (...args: any[]) => (poll.xread as any)(...args),
        xrange: (...args: any[]) => (restore.xrange as any)(...args),
    };
}

export interface BoundedAdapterOptions {
    streamName: string;
    sessionKeyPrefix: string;
    maxLen: number;
    readCount: number;
    heartbeatInterval: number;
    heartbeatTimeout: number;
    limits: RecoveryLimits;
    observer?: RecoveryObserver;
    decodeSession(raw: string): any;
}

export function createBoundedStreamsAdapter(connections: AdapterConnections, options: BoundedAdapterOptions) {
    const facade = createAdapterClientFacade(connections);
    const inner = createAdapter(facade as any, {
        streamName: options.streamName,
        sessionKeyPrefix: options.sessionKeyPrefix,
        maxLen: options.maxLen,
        readCount: options.readCount,
        heartbeatInterval: options.heartbeatInterval,
        heartbeatTimeout: options.heartbeatTimeout,
    });
    const gate = new RecoveryGate(options.limits.maxConcurrent, options.limits.queueTimeoutMs);
    const deps: BoundedRestoreDeps = {
        publish: connections.publish as unknown as PublishClient,
        restore: connections.restore as unknown as RestoreClient,
        streamName: options.streamName,
        sessionKeyPrefix: options.sessionKeyPrefix,
        limits: options.limits,
        gate,
        decodeSession: options.decodeSession,
        observer: options.observer,
    };
    // socket.io instantiates the factory with `new` (namespace._initAdapter),
    // so this must be a plain function, not an arrow; returning an object from
    // a constructor is what the stock factory relies on too.
    return function boundedAdapterFactory(nsp: any) {
        const adapter = inner(nsp) as unknown as AdapterLike;
        adapter.restoreSession = (pid: string, offset: string) => boundedRestoreSession(adapter, deps, pid, offset);
        return adapter as any;
    };
}
