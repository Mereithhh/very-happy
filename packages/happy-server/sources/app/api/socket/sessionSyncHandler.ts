/**
 * B-811 (B-807 spec §3–4, PR-5a): `sync-hello`, `session-subscribe` and
 * `session-unsubscribe` — snapshot-reconciled subscriptions for web sockets.
 *
 * Dark-launched: no client calls these yet (PR-5b). Live delivery is NOT
 * changed — pushes keep riding `update/new-message` to the user-scoped room —
 * so everything here is additive and `SYNC_SUBSCRIBE_DISABLED=1` turns it into
 * an immediate `{ ok:false, error:'disabled' }` without touching the DB.
 *
 * Atomicity (spec §4.2): the socket must already be in `user:<uid>:user-scoped`
 * when the snapshot statement starts. eventRouter.addConnection joins it before
 * any handler is registered; `ensureInUserRoom` re-asserts that locally so this
 * handler's correctness never depends on registration order elsewhere.
 *
 * Storm protection (§4.4, B-711/B-494): a per-slot FIFO gate bounds concurrent
 * snapshot reads (queue wait > 3s → `unavailable` with a jittered retryAfter),
 * a per-socket sliding window bounds hello+subscribe, and one ack carries at
 * most 512KB of messages.
 */
import type { Socket } from 'socket.io';
import {
    SESSION_SUBSCRIBE_EVENT,
    SESSION_UNSUBSCRIBE_EVENT,
    SYNC_DEFAULT_GAP_THRESHOLD,
    SYNC_DEFAULT_LIMIT,
    SYNC_HELLO_EVENT,
    SYNC_MAX_LIMIT,
    SYNC_MAX_SUBS,
    SYNC_PROTOCOL_VERSION,
    sessionSubscribeRequestSchema,
    sessionUnsubscribeRequestSchema,
    syncHelloRequestSchema,
    type SessionUnsubscribeAck,
    type SyncHelloAck,
    type SyncHelloError,
    type SyncSubError,
    type SyncSubRequest,
    type SyncSubResult,
    type SyncSubResultOk,
} from '@slopus/happy-wire';
import { db } from '@/storage/db';
import { resolveSessionAccess } from '@/app/session/sessionShares';
import {
    applyAckBudget,
    buildSubResult,
    planSnapshot,
    readSessionHeads,
    readSessionSnapshot,
    type SnapshotClient,
} from '@/app/session/sessionSyncSnapshot';
import {
    syncGapTooLargeCounter,
    syncHelloCounter,
    syncHelloQueueWait,
    syncSnapshotDuration,
    syncSubscribeCounter,
    syncSubscriptionsGauge,
} from '@/app/monitoring/metrics2';
import { log } from '@/utils/log';

// ---------------------------------------------------------------- config

export interface SessionSyncConfig {
    disabled: boolean;
    /** SYNC_SUBSCRIBE_ACCOUNTS: when set, only these accounts get ok:true. */
    accounts: Set<string> | null;
    gapThreshold: number;
    maxConcurrency: number;
    queueTimeoutMs: number;
    /** Snapshot work deadline once a gate slot is held. */
    snapshotTimeoutMs: number;
    rateLimit: { max: number; windowMs: number };
    ackBudgetBytes: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveSessionSyncConfig(env: NodeJS.ProcessEnv = process.env): SessionSyncConfig {
    const accounts = (env.SYNC_SUBSCRIBE_ACCOUNTS ?? '').split(',').map((id) => id.trim()).filter(Boolean);
    return {
        disabled: env.SYNC_SUBSCRIBE_DISABLED === '1',
        accounts: accounts.length > 0 ? new Set(accounts) : null,
        gapThreshold: positiveInt(env.SYNC_GAP_THRESHOLD, SYNC_DEFAULT_GAP_THRESHOLD),
        maxConcurrency: positiveInt(env.SYNC_HELLO_MAX_CONCURRENCY, 32),
        queueTimeoutMs: 3_000,
        snapshotTimeoutMs: 1_500,
        rateLimit: { max: 20, windowMs: 10_000 },
        ackBudgetBytes: 512 * 1024,
    };
}

// ---------------------------------------------------------------- gate

export interface SnapshotGate {
    /** Resolves with a release function, or null when the queue wait timed out. */
    acquire(timeoutMs: number): Promise<(() => void) | null>;
    readonly active: number;
    readonly queued: number;
}

/** Strict FIFO counting semaphore: a freed slot goes to the oldest waiter. */
export function createSnapshotGate(concurrency: number): SnapshotGate {
    let active = 0;
    const waiters: Array<{ grant: () => void }> = [];
    const release = () => {
        const next = waiters.shift();
        if (next) next.grant();
        else active -= 1;
    };
    const once = () => {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            release();
        };
    };
    return {
        get active() { return active; },
        get queued() { return waiters.length; },
        acquire(timeoutMs) {
            if (active < concurrency) {
                active += 1;
                return Promise.resolve(once());
            }
            return new Promise((resolve) => {
                const waiter = {
                    grant: () => {
                        clearTimeout(timer);
                        resolve(once());
                    },
                };
                const timer = setTimeout(() => {
                    const index = waiters.indexOf(waiter);
                    if (index >= 0) waiters.splice(index, 1);
                    resolve(null);
                }, timeoutMs);
                timer.unref?.();
                waiters.push(waiter);
            });
        },
    };
}

// ---------------------------------------------------------------- rate limit

/** Per-socket sliding window. Returns 0 when allowed, else ms until a slot frees. */
export function createSocketRateLimiter(limit: { max: number; windowMs: number }, now: () => number = Date.now) {
    const hits: number[] = [];
    return () => {
        const t = now();
        while (hits.length > 0 && t - hits[0] >= limit.windowMs) hits.shift();
        if (hits.length >= limit.max) return Math.max(1, limit.windowMs - (t - hits[0]));
        hits.push(t);
        return 0;
    };
}

// ---------------------------------------------------------------- deps

export interface SessionSyncDeps {
    config: () => SessionSyncConfig;
    gate: SnapshotGate;
    client: SnapshotClient;
    resolveAccess: (userId: string, sessionId: string) => Promise<unknown | null>;
    now: () => number;
    random: () => number;
    /** Test-only interleaving points (spec §9.1-1). */
    hooks?: {
        beforeSnapshot?: () => Promise<void> | void;
        afterSnapshot?: () => Promise<void> | void;
    };
}

let defaultDeps: SessionSyncDeps | null = null;
function getDefaultDeps(): SessionSyncDeps {
    if (!defaultDeps) {
        const initial = resolveSessionSyncConfig();
        defaultDeps = {
            config: resolveSessionSyncConfig,
            gate: createSnapshotGate(initial.maxConcurrency),
            client: db,
            resolveAccess: resolveSessionAccess,
            now: Date.now,
            random: Math.random,
        };
    }
    return defaultDeps;
}

// ---------------------------------------------------------------- core

type ConnectionLike = { connectionType: string };
export type SyncSubsTable = Map<string, { since: number; afterSeqAtAck: number }>;

class SyncOpError extends Error {
    constructor(readonly code: 'unavailable', readonly retryAfterMs?: number) { super(code); }
}

function userRoom(userId: string) {
    return `user:${userId}:user-scoped`;
}

/** Spec §4.2 precondition: in the push room BEFORE the snapshot starts. */
export function ensureInUserRoom(socket: Pick<Socket, 'rooms' | 'join'>, userId: string) {
    const room = userRoom(userId);
    if (!socket.rooms.has(room)) void socket.join(room);
}

function clampLimit(limit: number | undefined) {
    return Math.min(limit ?? SYNC_DEFAULT_LIMIT, SYNC_MAX_LIMIT);
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new SyncOpError('unavailable')), ms);
        timer.unref?.();
        work.then(
            (value) => { clearTimeout(timer); resolve(value); },
            (error) => { clearTimeout(timer); reject(error); },
        );
    });
}

/**
 * Hold one gate slot for the whole snapshot of a hello/subscribe. The slot is
 * released when the DB work actually settles, even if the ack already went
 * out as `unavailable` on the deadline — otherwise a slow DB would let the
 * gate admit unbounded concurrent queries.
 */
async function underGate<T>(deps: SessionSyncDeps, op: 'hello' | 'subscribe', work: () => Promise<T>): Promise<T> {
    const config = deps.config();
    const queuedAt = deps.now();
    const release = await deps.gate.acquire(config.queueTimeoutMs);
    syncHelloQueueWait.observe({ op }, Math.max(0, deps.now() - queuedAt) / 1000);
    if (!release) {
        throw new SyncOpError('unavailable', 500 + Math.floor(deps.random() * 1000));
    }
    const startedAt = deps.now();
    const running = work();
    void running.then(release, release);
    try {
        return await withDeadline(running, config.snapshotTimeoutMs);
    } finally {
        syncSnapshotDuration.observe({ op }, Math.max(0, deps.now() - startedAt) / 1000);
    }
}

/**
 * Resolve every sub against one batched head read, then run the §4.2
 * statement only for subs that have something past afterSeq (or are cold).
 * Owner check rides the head row; anything else goes through
 * resolveSessionAccess, the REST GET's own predicate (grantee / revoked /
 * expired). Unknown and forbidden are both `not_found` (§4.5).
 */
async function snapshotSubs(
    deps: SessionSyncDeps,
    userId: string,
    subs: SyncSubRequest[],
): Promise<Array<SyncSubResultOk | { sid: string; ok: false; error: SyncSubError }>> {
    const config = deps.config();
    await deps.hooks?.beforeSnapshot?.();
    const heads = await readSessionHeads(deps.client, [...new Set(subs.map((sub) => sub.sid))]);
    const results = await Promise.all(subs.map(async (sub): Promise<SyncSubResultOk | { sid: string; ok: false; error: SyncSubError }> => {
        const head = heads.get(sub.sid);
        if (!head) return { sid: sub.sid, ok: false, error: 'not_found' };
        if (head.accountId !== userId && !await deps.resolveAccess(userId, sub.sid)) {
            return { sid: sub.sid, ok: false, error: 'not_found' };
        }
        const plan = planSnapshot(head.seq, sub.afterSeq, config.gapThreshold);
        if (plan.kind === 'none') return buildSubResult(sub.sid, plan, head.seq, null);
        const limit = clampLimit(sub.limit);
        const snapshot = plan.kind === 'increment'
            ? await readSessionSnapshot(deps.client, { sessionId: sub.sid, afterSeq: sub.afterSeq!, limit })
            : await readSessionSnapshot(deps.client, { sessionId: sub.sid, afterSeq: null, limit });
        if (!snapshot) return { sid: sub.sid, ok: false, error: 'not_found' };
        if (plan.kind === 'latest' && plan.gapTooLarge) syncGapTooLargeCounter.inc();
        return buildSubResult(sub.sid, plan, head.seq, snapshot);
    }));
    await deps.hooks?.afterSnapshot?.();
    return results;
}

function budgetResults<T extends { ok: boolean }>(results: T[], budget: number): T[] {
    const oks = results.filter((result): result is T & SyncSubResultOk => result.ok);
    const trimmed = applyAckBudget(oks, budget);
    let index = 0;
    return results.map((result) => result.ok ? trimmed[index++] as unknown as T : result);
}

function gateRefusal(config: SessionSyncConfig, connection: ConnectionLike, userId: string): SyncHelloError | null {
    if (connection.connectionType !== 'user-scoped') return 'unsupported_client';
    if (config.disabled) return 'disabled';
    if (config.accounts && !config.accounts.has(userId)) return 'disabled';
    return null;
}

export interface SessionSyncContext {
    userId: string;
    socket: Pick<Socket, 'rooms' | 'join'> & { data: Record<string, any> };
    connection: ConnectionLike;
    rateLimit: () => number;
    deps: SessionSyncDeps;
}

function subsTable(ctx: SessionSyncContext): SyncSubsTable {
    if (!(ctx.socket.data.syncSubs instanceof Map)) ctx.socket.data.syncSubs = new Map();
    return ctx.socket.data.syncSubs as SyncSubsTable;
}

function setSubscription(ctx: SessionSyncContext, table: SyncSubsTable, sid: string, afterSeqAtAck: number) {
    // An ack that lands after disconnect must not re-grow a released table.
    if (ctx.socket.data.syncClosed) return;
    const existing = table.get(sid);
    if (!existing) syncSubscriptionsGauge.inc();
    table.set(sid, { since: existing?.since ?? ctx.deps.now(), afterSeqAtAck });
}

export async function handleSyncHello(ctx: SessionSyncContext, raw: unknown): Promise<SyncHelloAck> {
    const config = ctx.deps.config();
    const refusal = gateRefusal(config, ctx.connection, ctx.userId);
    if (refusal) return { ok: false, error: refusal };
    const retryAfterMs = ctx.rateLimit();
    if (retryAfterMs > 0) return { ok: false, error: 'rate_limited', retryAfterMs };
    const parsed = syncHelloRequestSchema.safeParse(raw);
    if (!parsed.success || parsed.data.v < 1) return { ok: false, error: 'invalid_request' };

    const honoured = parsed.data.subs.slice(0, SYNC_MAX_SUBS);
    ensureInUserRoom(ctx.socket, ctx.userId);
    let snapshots;
    try {
        snapshots = await underGate(ctx.deps, 'hello', () => snapshotSubs(ctx.deps, ctx.userId, honoured));
    } catch (error) {
        if (!(error instanceof SyncOpError)) log({ module: 'session-sync', userId: ctx.userId, error }, 'sync-hello snapshot failed');
        return { ok: false, error: 'unavailable', ...(error instanceof SyncOpError && error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}) };
    }
    const results: SyncSubResult[] = [
        ...budgetResults(snapshots, config.ackBudgetBytes),
        ...parsed.data.subs.slice(SYNC_MAX_SUBS).map((sub) => ({ sid: sub.sid, ok: false as const, error: 'too_many_subscriptions' as const })),
    ];

    // Hello carries every subscription: it rebuilds the table.
    const table = subsTable(ctx);
    const keep = new Set<string>();
    for (const result of results) {
        if (!result.ok) continue;
        keep.add(result.sid);
        setSubscription(ctx, table, result.sid, result.headSeq);
    }
    for (const sid of [...table.keys()]) {
        if (keep.has(sid)) continue;
        table.delete(sid);
        syncSubscriptionsGauge.dec();
    }

    return {
        ok: true,
        v: Math.min(SYNC_PROTOCOL_VERSION, parsed.data.v),
        serverTime: ctx.deps.now(),
        limits: { maxSubs: SYNC_MAX_SUBS, maxLimit: SYNC_MAX_LIMIT, gapThreshold: config.gapThreshold },
        results,
    };
}

function sidOf(raw: unknown): string {
    const sid = (raw as { sid?: unknown } | null)?.sid;
    return typeof sid === 'string' ? sid : '';
}

export async function handleSessionSubscribe(ctx: SessionSyncContext, raw: unknown): Promise<SyncSubResult> {
    const config = ctx.deps.config();
    const refusal = gateRefusal(config, ctx.connection, ctx.userId);
    if (refusal) return { sid: sidOf(raw), ok: false, error: refusal };
    const retryAfterMs = ctx.rateLimit();
    if (retryAfterMs > 0) return { sid: sidOf(raw), ok: false, error: 'rate_limited', retryAfterMs };
    const parsed = sessionSubscribeRequestSchema.safeParse(raw);
    if (!parsed.success || parsed.data.v < 1) return { sid: sidOf(raw), ok: false, error: 'invalid_request' };
    const { sid, afterSeq, limit } = parsed.data;

    const table = subsTable(ctx);
    if (!table.has(sid) && table.size >= SYNC_MAX_SUBS) return { sid, ok: false, error: 'too_many_subscriptions' };

    ensureInUserRoom(ctx.socket, ctx.userId);
    let result;
    try {
        [result] = await underGate(ctx.deps, 'subscribe', () => snapshotSubs(ctx.deps, ctx.userId, [{ sid, afterSeq, limit }]));
    } catch (error) {
        if (!(error instanceof SyncOpError)) log({ module: 'session-sync', userId: ctx.userId, error }, 'session-subscribe snapshot failed');
        return { sid, ok: false, error: 'unavailable', ...(error instanceof SyncOpError && error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}) };
    }
    if (!result.ok) {
        if (table.delete(sid)) syncSubscriptionsGauge.dec();
        return result;
    }
    const [budgeted] = applyAckBudget([result], config.ackBudgetBytes);
    // Re-check: a concurrent subscribe may have filled the table meanwhile.
    if (!table.has(sid) && table.size >= SYNC_MAX_SUBS) return { sid, ok: false, error: 'too_many_subscriptions' };
    setSubscription(ctx, table, sid, budgeted.headSeq);
    return budgeted;
}

export function handleSessionUnsubscribe(ctx: SessionSyncContext, raw: unknown): SessionUnsubscribeAck {
    const refusal = gateRefusal(ctx.deps.config(), ctx.connection, ctx.userId);
    if (refusal) return { ok: false, error: refusal };
    const parsed = sessionUnsubscribeRequestSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid_request' };
    if (subsTable(ctx).delete(parsed.data.sid)) syncSubscriptionsGauge.dec();
    return { ok: true };
}

function resultLabel(result: { ok: boolean; error?: string }): string {
    return result.ok ? 'ok' : result.error ?? 'unknown';
}

// ---------------------------------------------------------------- socket wiring

export function sessionSyncHandler(
    userId: string,
    socket: Socket,
    connection: ConnectionLike,
    deps: SessionSyncDeps = getDefaultDeps(),
) {
    const ctx: SessionSyncContext = {
        userId,
        socket,
        connection,
        rateLimit: createSocketRateLimiter(deps.config().rateLimit, deps.now),
        deps,
    };

    socket.on(SYNC_HELLO_EVENT, async (data: unknown, ack?: unknown) => {
        if (typeof ack !== 'function') return;
        const response = await handleSyncHello(ctx, data).catch((error): SyncHelloAck => {
            log({ module: 'session-sync', userId, error }, 'sync-hello failed');
            return { ok: false, error: 'unavailable' };
        });
        syncHelloCounter.inc({ result: resultLabel(response) });
        ack(response);
    });

    socket.on(SESSION_SUBSCRIBE_EVENT, async (data: unknown, ack?: unknown) => {
        if (typeof ack !== 'function') return;
        const response = await handleSessionSubscribe(ctx, data).catch((error): SyncSubResult => {
            log({ module: 'session-sync', userId, error }, 'session-subscribe failed');
            return { sid: sidOf(data), ok: false, error: 'unavailable' };
        });
        syncSubscribeCounter.inc({ result: resultLabel(response) });
        ack(response);
    });

    socket.on(SESSION_UNSUBSCRIBE_EVENT, (data: unknown, ack?: unknown) => {
        const response = handleSessionUnsubscribe(ctx, data);
        if (typeof ack === 'function') ack(response);
    });

    socket.on('disconnect', () => {
        socket.data.syncClosed = true;
        const table = socket.data.syncSubs;
        if (table instanceof Map && table.size > 0) {
            syncSubscriptionsGauge.dec(table.size);
            table.clear();
        }
    });
}
