/**
 * B-812 (B-807 spec §5.2, PR-5b): the ONE place that decides how a session's
 * messages are caught up — `sync-hello`, `session-subscribe`, or the REST
 * path (legacy mode / fallback). Every trigger (connect, recovered, handover
 * candidate, resume edge, open, gap, retry, online, the 120s reconcile) is an
 * event handed to it; sync.ts no longer decides per call site.
 *
 * Per connection the mode is negotiated: each connect sends one `sync-hello`
 * (with every subscription) and waits SYNC_FIRST_HELLO_TIMEOUT_MS. An `ok`
 * ack → subscribe mode; `disabled` / `unsupported_client` / `invalid_request`,
 * no ack within 2s (an old server: no handler, so no ack ever) → legacy for
 * THIS connection — exactly the PR-1..3 behaviour; a late ack is ignored and
 * the next connect negotiates again. While the socket is down the REST path
 * is used too (it often works while the socket is still reconnecting, B-803b).
 *
 * Subscriptions: the sessions opened in this tab, kept 5 minutes after the
 * user leaves them (switching back costs nothing), at most 8, least recently
 * viewed evicted. Sessions outside the set keep the legacy path (live pushes,
 * the B-805 one-time first page, REST on a gap).
 *
 * Pure apart from its injected dependencies (socket emit, timers, the merge
 * in sync.ts) — driven by a fake socket and fake timers in the tests.
 */
import {
    SESSION_SUBSCRIBE_EVENT,
    SESSION_UNSUBSCRIBE_EVENT,
    SYNC_ACK_TIMEOUT_MS,
    SYNC_DEFAULT_LIMIT,
    SYNC_FIRST_HELLO_TIMEOUT_MS,
    SYNC_HELLO_ERRORS,
    SYNC_HELLO_EVENT,
    SYNC_PROTOCOL_VERSION,
    SYNC_SUB_ERRORS,
    readSyncError,
    syncHelloAckSchema,
    syncSubResultSchema,
    type SyncSubResultOk,
} from '@slopus/happy-wire';
import {
    initialSyncState,
    transition,
    type AckOutcome,
    type SessionSyncState,
    type SyncEffect,
    type SyncEvent,
} from './sessionSyncState';

export type SyncMode = 'down' | 'negotiating' | 'subscribe' | 'legacy';
export type HelloReason = 'connect' | 'recovered' | 'handover' | 'resume' | 'retry' | 'online';

/** Leave a session → its subscription stays this long (spec §5.2). */
export const SUBSCRIPTION_RETAIN_MS = 5 * 60_000;
export const MAX_SUBSCRIPTIONS = 8;
/** live + visible → one empty subscribe this often (spec §4.2: lost-emit bound). */
export const RECONCILE_INTERVAL_MS = 120_000;
/**
 * A resume / retry / online hello still unanswered after this (2–4 mobile RTTs) → the viewed
 * session also gets the REST catch-up, the hello stays out (e2e B6: a socket
 * that died in the background answered nothing until the 5s deadline; the
 * REST path had caught up in 0.4s). A healthy hello answers in tens of ms.
 */
export const HELLO_HEDGE_MS = 600;
/** Cold open while the hello is unanswered → REST first page in parallel after this (spec §6.3). */
export const NEGOTIATION_REST_DELAY_MS = 200;

export type SubscribeRequest = { afterSeq: number | null; generation: number; epoch: number };

export type SchedulerDeps = {
    /** Emit with an ack deadline; rejects on timeout or a dropped connection. */
    emit: (event: string, payload: unknown, timeoutMs: number) => Promise<unknown>;
    connected: () => boolean;
    lastSeq: (sid: string) => number | undefined;
    /** Cold subscribes ask for this many (the first page). */
    coldLimit: number;
    /**
     * B-813 × B-812: before a cold subscribe, render the session's cached run
     * if there is one (spec §5.3: OPEN, cache hit → syncing, subscribe(lastSeq)).
     */
    prepareCold?: (sid: string) => Promise<void>;
    /** afterSeq to ask with instead of lastSeq (a cached run asks from its newest row - 1 to check that row). */
    requestAfterSeq?: (sid: string) => number | undefined;
    /** Decrypt + merge one ok result (sync.ts mergeSessionMessages). */
    applyResult: (sid: string, result: SyncSubResultOk, request: SubscribeRequest) => Promise<AckOutcome>;
    /** headSeq behind the request: drop the session's window + cursor. */
    invalidate: (sid: string) => void;
    /** One REST catch-up of a session (legacy path, restart semantics). */
    rest: (sid: string) => Promise<void>;
    /** The legacy reaction to a connection-wide trigger (reconnect / resume / retry). */
    legacy: (reason: HelloReason | 'open' | 'gap' | 'catch-up', sid?: string) => void;
    checkLiveness: () => void;
    offline: () => boolean;
    visible: () => boolean;
    viewing: () => string | null;
    /** `vh.sync.mode=legacy` on this device (spec §6.1). */
    forcedLegacy: () => boolean;
    /**
     * The last negotiated mode on this device (a speed hint only): after a
     * legacy connection (old server, rollback window, switch off) a cold open
     * during the next negotiation fetches its first page at once instead of
     * after NEGOTIATION_REST_DELAY_MS.
     */
    lastMode: () => 'subscribe' | 'legacy' | null;
    noteMode: (mode: 'subscribe' | 'legacy') => void;
    /** Phase changes of subscribed sessions in subscribe mode; null = not driven by the scheduler any more. */
    onPhase: (sid: string, state: SessionSyncState | null) => void;
    onRemoved: (sid: string) => void;
    now: () => number;
    setTimer: (fn: () => void, ms: number) => unknown;
    clearTimer: (timer: unknown) => void;
    random: () => number;
    log: (message: string) => void;
};

type Subscription = {
    state: SessionSyncState;
    lastViewedAt: number;
    retainTimer: unknown;
    reconcileTimer: unknown;
    retryTimer: unknown;
    restTimer: unknown;
    restInflight: boolean;
    restDoneAt: number;
    /** prepareCold (the cached run) is being read for this cold open. */
    preparing: boolean;
    inflight: SubscribeRequest | null;
    again: boolean;
    againCold: boolean;
    waiters: Array<() => void>;
};

export class SessionSyncScheduler {
    private mode: SyncMode = 'down';
    private epoch = 0;
    private subs = new Map<string, Subscription>();
    private negotiation: Promise<void> | null = null;
    /** Hello requests answered so far / falling back — counters for the e2e and the debug panel. */
    readonly stats = { hello: 0, subscribe: 0, legacy: 0, helloTimeout: 0, helloHedge: 0 };

    constructor(private deps: SchedulerDeps) {}

    getMode(): SyncMode {
        return this.mode;
    }

    isSubscribed(sid: string): boolean {
        return this.subs.has(sid);
    }

    /** True when `sid` is caught up over the socket right now (not the REST path). */
    drives(sid: string): boolean {
        return this.mode === 'subscribe' && this.subs.has(sid);
    }

    phase(sid: string): SessionSyncState | null {
        return this.subs.get(sid)?.state ?? null;
    }

    // ── connection-wide triggers ──────────────────────────────────────

    /** A (re)connect, a recovered connect, or a handover candidate connected. Resolves when the hello is settled. */
    connect(reason: 'connect' | 'recovered' | 'handover'): Promise<void> {
        this.epoch += 1;
        if (this.deps.forcedLegacy()) {
            this.enterLegacy(reason);
            return Promise.resolve();
        }
        this.mode = 'negotiating';
        for (const sid of this.subs.keys()) this.dispatch(sid, { t: 'connect' });
        const run = this.hello(reason, SYNC_FIRST_HELLO_TIMEOUT_MS);
        this.negotiation = run;
        return run.finally(() => {
            if (this.negotiation === run) this.negotiation = null;
        });
    }

    disconnected() {
        this.epoch += 1;
        this.mode = 'down';
        for (const [sid, sub] of this.subs) {
            sub.inflight = null;
            this.clear(sub, 'retryTimer');
            this.dispatch(sid, { t: 'socket-down' });
        }
    }

    /** The web resume edge (sync.onWebResume only — 铁律 13). */
    resume() {
        if (this.mode === 'subscribe' && this.deps.connected()) {
            for (const sid of this.subs.keys()) this.dispatch(sid, { t: 'resume' });
            void this.hello('resume', SYNC_ACK_TIMEOUT_MS);
            return;
        }
        this.deps.legacy('resume');
    }

    /** 「重试」: generation + 1, hello now. False → the caller takes the legacy path. */
    retry(sid: string): boolean {
        if (!(this.mode === 'subscribe' && this.deps.connected() && this.subs.has(sid))) return false;
        for (const id of this.subs.keys()) this.dispatch(id, { t: 'retry' });
        void this.hello('retry', SYNC_ACK_TIMEOUT_MS);
        return true;
    }

    offline() {
        for (const sid of this.subs.keys()) this.dispatch(sid, { t: 'offline' });
    }

    /** Browser back online. In subscribe mode on a live socket: hello; otherwise connect/resume will. */
    online() {
        if (!(this.mode === 'subscribe' && this.deps.connected())) return;
        for (const sid of this.subs.keys()) this.dispatch(sid, { t: 'online' });
        void this.hello('online', SYNC_ACK_TIMEOUT_MS);
    }

    // ── per-session triggers ──────────────────────────────────────────

    /** The user entered `sid` (screen mount). */
    open(sid: string) {
        const sub = this.ensure(sid);
        sub.lastViewedAt = this.deps.now();
        this.clear(sub, 'retainTimer');
        // A cold open renders the cached run first (B-813), whatever the mode: it is local.
        if (this.deps.prepareCold && sub.state.phase === 'cold' && this.deps.lastSeq(sid) === undefined && this.mode !== 'legacy' && this.mode !== 'down') {
            if (sub.preparing) return;
            sub.preparing = true;
            void this.deps.prepareCold(sid).catch(() => {}).then(() => {
                sub.preparing = false;
                if (this.subs.get(sid) === sub && sub.state.phase === 'cold') this.continueOpen(sid, sub);
            });
            return;
        }
        this.continueOpen(sid, sub);
    }

    private continueOpen(sid: string, sub: Subscription) {
        if (this.mode === 'subscribe') {
            this.dispatch(sid, { t: 'open', anchored: this.deps.lastSeq(sid) !== undefined });
            return;
        }
        if (this.mode === 'negotiating') {
            // Spec §6.3: a cold open does not wait for the hello — REST first page in parallel after 200ms.
            if (this.deps.lastSeq(sid) === undefined && !sub.restTimer) {
                const delay = this.deps.lastMode() === 'legacy' ? 0 : NEGOTIATION_REST_DELAY_MS;
                sub.restTimer = this.deps.setTimer(() => {
                    sub.restTimer = null;
                    // An ok ack already subscribed it (cold → loading over the socket).
                    if (this.mode !== 'subscribe') this.deps.legacy('open', sid);
                }, delay);
            }
            return;
        }
        this.deps.legacy('open', sid);
    }

    /** The viewed session changed; the one left keeps its subscription SUBSCRIPTION_RETAIN_MS. */
    view(previous: string | null, next: string | null) {
        const now = this.deps.now();
        if (next) {
            const sub = this.subs.get(next);
            if (sub) {
                sub.lastViewedAt = now;
                this.clear(sub, 'retainTimer');
            }
        }
        if (previous && previous !== next) {
            const sub = this.subs.get(previous);
            if (!sub) return;
            sub.lastViewedAt = now;
            this.clear(sub, 'retainTimer');
            sub.retainTimer = this.deps.setTimer(() => {
                sub.retainTimer = null;
                if (this.deps.viewing() !== previous) this.unsubscribe(previous);
            }, SUBSCRIPTION_RETAIN_MS);
        }
    }

    /** The reorder window closed with a hole. False → the caller takes the legacy path. */
    gap(sid: string): boolean {
        if (!this.drives(sid)) return false;
        this.dispatch(sid, { t: 'push-gap' });
        return true;
    }

    /**
     * One catch-up whose completion the caller awaits (prompt-queue hand-off
     * verification, control returned). Null → not driven here, use REST.
     */
    catchUp(sid: string): Promise<void> | null {
        const sub = this.subs.get(sid);
        if (!sub || this.mode !== 'subscribe' || !this.deps.connected()) return null;
        const done = new Promise<void>((resolve) => sub.waiters.push(resolve));
        this.subscribe(sid, false);
        return done;
    }

    /** The session is gone (deleted locally). */
    forget(sid: string) {
        const sub = this.subs.get(sid);
        if (!sub) return;
        this.clearAll(sub);
        this.subs.delete(sid);
        this.release(sub);
        this.deps.onPhase(sid, null);
    }

    // ── internals ─────────────────────────────────────────────────────

    private ensure(sid: string): Subscription {
        let sub = this.subs.get(sid);
        if (sub) return sub;
        sub = {
            state: initialSyncState(),
            lastViewedAt: this.deps.now(),
            retainTimer: null, reconcileTimer: null, retryTimer: null, restTimer: null, restInflight: false, restDoneAt: 0, preparing: false,
            inflight: null, again: false, againCold: false, waiters: [],
        };
        this.subs.set(sid, sub);
        this.evictOver(MAX_SUBSCRIPTIONS, sid);
        return sub;
    }

    /** Keep at most `limit` subscriptions; the least recently viewed (never `keep` or the viewed one) go. */
    private evictOver(limit: number, keep: string) {
        if (this.subs.size <= limit) return;
        const viewing = this.deps.viewing();
        const victims = [...this.subs.entries()]
            .filter(([sid]) => sid !== keep && sid !== viewing)
            .sort((a, b) => a[1].lastViewedAt - b[1].lastViewedAt);
        while (this.subs.size > limit && victims.length > 0) this.unsubscribe(victims.shift()![0]);
    }

    private unsubscribe(sid: string) {
        const sub = this.subs.get(sid);
        if (!sub) return;
        this.clearAll(sub);
        this.subs.delete(sid);
        this.release(sub);
        this.deps.onPhase(sid, null);
        if (this.mode === 'subscribe' && this.deps.connected()) {
            this.deps.emit(SESSION_UNSUBSCRIBE_EVENT, { v: SYNC_PROTOCOL_VERSION, sid }, SYNC_ACK_TIMEOUT_MS).catch(() => {});
        }
    }

    private enterLegacy(reason: HelloReason) {
        this.mode = 'legacy';
        this.stats.legacy += 1;
        if (!this.deps.forcedLegacy()) this.deps.noteMode('legacy');
        for (const [sid, sub] of this.subs) {
            sub.inflight = null;
            this.clear(sub, 'retryTimer');
            this.clear(sub, 'reconcileTimer');
            this.release(sub);
            this.deps.onPhase(sid, null);
        }
        this.deps.log(`🔁 sync: legacy mode for this connection (${reason})`);
        this.deps.legacy(reason);
    }

    private subRequest(sid: string, cold: boolean) {
        const lastSeq = this.deps.lastSeq(sid);
        const afterSeq = cold || lastSeq === undefined ? null : (this.deps.requestAfterSeq?.(sid) ?? lastSeq);
        return { sid, afterSeq, ...(afterSeq === null ? { limit: this.deps.coldLimit } : { limit: SYNC_DEFAULT_LIMIT }) };
    }

    private async hello(reason: HelloReason, timeoutMs: number): Promise<void> {
        const epoch = this.epoch;
        const sids = [...this.subs.keys()];
        const requests = new Map<string, SubscribeRequest>();
        const subs = sids.map((sid) => {
            const sub = this.subs.get(sid)!;
            const req = this.subRequest(sid, false);
            const request: SubscribeRequest = { afterSeq: req.afterSeq, generation: sub.state.generation, epoch };
            requests.set(sid, request);
            sub.inflight = request;
            sub.again = false;
            return req;
        });
        this.stats.hello += 1;
        let raw: unknown;
        let answered = false;
        const hedge = reason === 'resume' || reason === 'retry' || reason === 'online'
            ? this.deps.setTimer(() => {
                const viewing = this.deps.viewing();
                if (!answered && epoch === this.epoch && viewing && requests.has(viewing)) {
                    this.stats.helloHedge += 1;
                    this.runRest(viewing);
                }
            }, HELLO_HEDGE_MS)
            : null;
        try {
            raw = await this.deps.emit(SYNC_HELLO_EVENT, { v: SYNC_PROTOCOL_VERSION, subs, reason }, timeoutMs);
            answered = true;
            if (hedge) this.deps.clearTimer(hedge);
        } catch {
            answered = true;
            if (hedge) this.deps.clearTimer(hedge);
            if (epoch !== this.epoch) return;
            for (const sid of sids) this.endInflight(sid, requests.get(sid)!);
            if (this.mode === 'negotiating') {
                // No ack within 2s: an old server (no handler) or a switch window.
                this.stats.helloTimeout += 1;
                this.enterLegacy(reason);
                return;
            }
            this.stats.helloTimeout += 1;
            for (const sid of sids) if (this.subs.has(sid)) this.ackTimeout(sid);
            return;
        }
        if (epoch !== this.epoch) return; // a late ack of an older connection
        const parsed = syncHelloAckSchema.safeParse(raw);
        if (!parsed.success || (parsed.data.ok && parsed.data.v < SYNC_PROTOCOL_VERSION)) {
            for (const sid of sids) this.endInflight(sid, requests.get(sid)!);
            this.enterLegacy(reason);
            return;
        }
        const ack = parsed.data;
        if (!ack.ok) {
            const error = readSyncError(ack.error, SYNC_HELLO_ERRORS);
            for (const sid of sids) this.endInflight(sid, requests.get(sid)!);
            if (error === 'disabled' || error === 'unsupported_client' || error === 'invalid_request') {
                this.enterLegacy(reason);
                return;
            }
            // rate_limited / unavailable: the handler exists — subscribe mode, each session backs off.
            this.mode = 'subscribe';
            this.deps.noteMode('subscribe');
            for (const sid of sids) this.dispatch(sid, { t: 'ack-error', error, retryAfterMs: ack.retryAfterMs, random: this.deps.random() });
            this.openUnannounced(requests);
            return;
        }
        this.mode = 'subscribe';
        this.deps.noteMode('subscribe');
        await Promise.all(sids.map(async (sid, index) => {
            const request = requests.get(sid)!;
            const result = ack.results[index];
            if (!result || result.sid !== sid) {
                this.endInflight(sid, request);
                this.dispatch(sid, { t: 'ack-error', error: 'unavailable' });
                return;
            }
            await this.handleResult(sid, request, result);
        }));
        this.openUnannounced(requests);
    }

    /** Sessions opened while the hello was out: they were not in it. */
    private openUnannounced(requests: Map<string, SubscribeRequest>) {
        for (const [sid, sub] of this.subs) {
            if (requests.has(sid) || sub.preparing) continue; // a cold open still reading its cache continues by itself
            if (sub.state.phase === 'cold') this.dispatch(sid, { t: 'open', anchored: this.deps.lastSeq(sid) !== undefined });
            else this.subscribe(sid, false);
        }
    }

    private subscribe(sid: string, cold: boolean) {
        const sub = this.subs.get(sid);
        if (!sub || this.mode !== 'subscribe' || !this.deps.connected()) return;
        if (sub.inflight) {
            sub.again = true;
            sub.againCold = sub.againCold || cold;
            return;
        }
        const req = this.subRequest(sid, cold);
        const request: SubscribeRequest = { afterSeq: req.afterSeq, generation: sub.state.generation, epoch: this.epoch };
        sub.inflight = request;
        this.stats.subscribe += 1;
        this.deps.emit(SESSION_SUBSCRIBE_EVENT, { v: SYNC_PROTOCOL_VERSION, ...req }, SYNC_ACK_TIMEOUT_MS).then(
            async (raw) => {
                if (request.epoch !== this.epoch || this.subs.get(sid) !== sub) return;
                const parsed = syncSubResultSchema.safeParse(raw);
                await this.handleResult(sid, request, parsed.success ? parsed.data : { sid, ok: false, error: 'invalid_request' });
            },
            () => {
                if (request.epoch !== this.epoch || this.subs.get(sid) !== sub) return;
                this.endInflight(sid, request);
                this.ackTimeout(sid);
            },
        );
    }

    private async handleResult(sid: string, request: SubscribeRequest, result: { ok: boolean } & Record<string, unknown>) {
        if (!result.ok) {
            this.endInflight(sid, request);
            const error = readSyncError(result.error, SYNC_SUB_ERRORS);
            const retryAfterMs = typeof result.retryAfterMs === 'number' ? result.retryAfterMs : undefined;
            this.dispatch(sid, { t: 'ack-error', error, retryAfterMs, random: this.deps.random() });
            return;
        }
        let outcome: AckOutcome;
        try {
            outcome = await this.deps.applyResult(sid, result as unknown as SyncSubResultOk, request);
        } catch (error) {
            this.deps.log(`🔁 sync: merge of ${sid} failed: ${error instanceof Error ? error.message : String(error)}`);
            outcome = { t: 'invalid' };
        }
        if (request.epoch !== this.epoch || !this.subs.has(sid)) return;
        this.endInflight(sid, request);
        this.dispatch(sid, { t: 'ack', outcome });
    }

    private endInflight(sid: string, request: SubscribeRequest) {
        const sub = this.subs.get(sid);
        if (!sub || sub.inflight !== request) return;
        sub.inflight = null;
        if (sub.again) {
            sub.again = false;
            const cold = sub.againCold;
            sub.againCold = false;
            queueMicrotask(() => this.subscribe(sid, cold));
        }
    }

    private ackTimeout(sid: string) {
        this.dispatch(sid, { t: 'ack-timeout' });
        // Progress without the socket: the viewed session also gets the REST catch-up (PR-1 path) —
        // unless the hello's hedge already landed one within this deadline.
        const sub = this.subs.get(sid);
        if (this.deps.viewing() === sid && sub && this.deps.now() - sub.restDoneAt > SYNC_ACK_TIMEOUT_MS) this.runRest(sid);
    }

    /** One REST catch-up at a time per session: a second trigger must not restart (abort) the one about to land. */
    private runRest(sid: string) {
        const sub = this.subs.get(sid);
        if (!sub || sub.restInflight) return;
        sub.restInflight = true;
        void this.deps.rest(sid).then(() => {
            sub.restInflight = false;
            sub.restDoneAt = this.deps.now();
            if (this.subs.get(sid) === sub) this.dispatch(sid, { t: 'rest-done' });
        }, () => { sub.restInflight = false; });
    }

    private dispatch(sid: string, event: SyncEvent) {
        const sub = this.subs.get(sid);
        if (!sub) return;
        const before = sub.state;
        const { state, effects } = transition(before, event);
        sub.state = state;
        if (state.phase === 'live') this.armReconcile(sid, sub);
        // A catch-up awaited by catchUp() is over either way: proved, or given up for now.
        if (state.phase === 'live' || state.phase === 'stale') this.release(sub);
        if (state !== before && (state.phase !== before.phase || state.staleReason !== before.staleReason) && this.mode === 'subscribe') {
            this.deps.onPhase(sid, state);
        }
        for (const effect of effects) this.run(sid, sub, effect);
    }

    private run(sid: string, sub: Subscription, effect: SyncEffect) {
        switch (effect.t) {
            case 'subscribe':
                if (effect.delayMs) {
                    this.clear(sub, 'retryTimer');
                    sub.retryTimer = this.deps.setTimer(() => {
                        sub.retryTimer = null;
                        this.subscribe(sid, effect.cold);
                    }, effect.delayMs);
                } else {
                    this.subscribe(sid, effect.cold);
                }
                return;
            case 'invalidate':
                this.deps.invalidate(sid);
                return;
            case 'rest':
                this.runRest(sid);
                return;
            case 'check-liveness':
                this.deps.checkLiveness();
                return;
            case 'remove':
                this.forget(sid);
                this.deps.onRemoved(sid);
                return;
            case 'legacy':
                this.epoch += 1;
                this.enterLegacy('connect');
                return;
            case 'evict-and-retry':
                this.evictOver(this.subs.size - 1, sid);
                this.subscribe(sid, sub.state.phase === 'loading');
                return;
        }
    }

    /** live + visible + viewed: one empty subscribe every RECONCILE_INTERVAL_MS after the last proof. */
    private armReconcile(sid: string, sub: Subscription) {
        this.clear(sub, 'reconcileTimer');
        sub.reconcileTimer = this.deps.setTimer(() => {
            sub.reconcileTimer = null;
            if (this.subs.get(sid) !== sub || sub.state.phase !== 'live') return;
            if (this.mode === 'subscribe' && this.deps.connected() && this.deps.visible() && this.deps.viewing() === sid && !this.deps.offline()) {
                this.dispatch(sid, { t: 'reconcile' });
            } else {
                this.armReconcile(sid, sub);
            }
        }, RECONCILE_INTERVAL_MS);
    }

    private release(sub: Subscription) {
        const waiters = sub.waiters;
        sub.waiters = [];
        for (const waiter of waiters) waiter();
    }

    private clear(sub: Subscription, key: 'retainTimer' | 'reconcileTimer' | 'retryTimer' | 'restTimer') {
        if (sub[key]) this.deps.clearTimer(sub[key]);
        sub[key] = null;
    }

    private clearAll(sub: Subscription) {
        this.clear(sub, 'retainTimer');
        this.clear(sub, 'reconcileTimer');
        this.clear(sub, 'retryTimer');
        this.clear(sub, 'restTimer');
    }
}
