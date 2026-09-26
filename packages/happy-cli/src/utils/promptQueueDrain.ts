/**
 * B-509 —— server-side prompt queue drain (pure state machine, no I/O).
 *
 * The web no longer releases queued prompts itself; it stores them on the
 * server (`/v1/sessions/:id/prompt-queue`). This process asks the server to
 * pop the head item into an ordinary user message (`POST …/dispatch`) exactly
 * when the runner is idle: its `MessageQueue2` is empty AND a consumer is
 * blocked waiting for the next message (the turn is over). The dispatched
 * message then arrives through the normal socket / catch-up path and is
 * routed like anything the user typed — so it starts a turn of its own,
 * never merged with a sibling (one item per turn).
 *
 * Guards, in order:
 *   - `closed` / `disabled` (404 from an old server → never retried);
 *   - a dispatch already in progress;
 *   - an `inflight` item whose message has not been routed yet (cleared by
 *     `onInbound(localId)`; released by timeout so a lost socket cannot wedge
 *     the queue — the catch-up fetch still delivers it in seq order);
 *   - an error backoff window;
 *   - `isIdle()` false.
 */
export type PromptQueueDispatchOutcome =
    | { kind: 'dispatched'; localId: string }
    | { kind: 'empty' }
    | { kind: 'unsupported' }
    | { kind: 'error'; message: string };

export type PromptQueueDrainDeps = {
    isIdle: () => boolean;
    dispatch: () => Promise<PromptQueueDispatchOutcome>;
    now?: () => number;
    log?: (message: string) => void;
    /** Schedules a retry after an error; default `setTimeout` (unref'd). */
    schedule?: (fn: () => void, delayMs: number) => void;
    inflightTimeoutMs?: number;
};

export const PROMPT_QUEUE_INFLIGHT_TIMEOUT_MS = 20_000;
export const PROMPT_QUEUE_RETRY_MIN_MS = 1_000;
export const PROMPT_QUEUE_RETRY_MAX_MS = 30_000;

export class PromptQueueDrain {
    private inflight: { localId: string; since: number } | null = null;
    /**
     * localIds routed while a dispatch call was still in flight. The server's
     * `new-message` echo regularly beats the HTTP response (both come off the
     * same transaction), so `onInbound` can precede the `dispatched` outcome;
     * without this the guard armed AFTER the message had arrived and sat
     * until the timeout — observed in the first isolated e2e run.
     */
    private arrivedDuringDispatch = new Set<string>();
    private disabled = false;
    private closed = false;
    private busy = false;
    private failures = 0;
    private retryAt = 0;
    private retryScheduled = false;
    private readonly now: () => number;
    private readonly log: (message: string) => void;
    private readonly schedule: (fn: () => void, delayMs: number) => void;
    private readonly inflightTimeoutMs: number;

    constructor(private readonly deps: PromptQueueDrainDeps) {
        this.now = deps.now ?? (() => Date.now());
        this.log = deps.log ?? (() => {});
        this.schedule = deps.schedule ?? ((fn, delayMs) => {
            const timer = setTimeout(fn, delayMs);
            (timer as { unref?: () => void }).unref?.();
        });
        this.inflightTimeoutMs = deps.inflightTimeoutMs ?? PROMPT_QUEUE_INFLIGHT_TIMEOUT_MS;
    }

    /** The runner is blocked on an empty input queue. */
    onIdle(): void {
        void this.maybeDispatch('idle');
    }

    /** A `prompt-queue` snapshot arrived; only a non-empty queue is worth a call. */
    onQueueChanged(count: number): void {
        if (count > 0) void this.maybeDispatch('queue-changed');
    }

    /** A user message with this localId was routed into the runner's queue. */
    onInbound(localId: string): void {
        if (this.inflight?.localId === localId) { this.inflight = null; return; }
        if (this.busy) {
            this.arrivedDuringDispatch.add(localId);
            if (this.arrivedDuringDispatch.size > 64) {
                const oldest = this.arrivedDuringDispatch.values().next().value;
                if (oldest !== undefined) this.arrivedDuringDispatch.delete(oldest);
            }
        }
    }

    close(): void {
        this.closed = true;
    }

    state() {
        return { inflight: this.inflight, disabled: this.disabled, busy: this.busy, failures: this.failures, retryAt: this.retryAt };
    }

    async maybeDispatch(reason: string): Promise<boolean> {
        if (this.closed || this.disabled || this.busy) return false;
        const now = this.now();
        if (this.inflight) {
            if (now - this.inflight.since < this.inflightTimeoutMs) return false;
            this.log(`[prompt-queue] inflight ${this.inflight.localId} not routed within ${this.inflightTimeoutMs}ms; releasing`);
            this.inflight = null;
        }
        if (now < this.retryAt) {
            this.scheduleRetry(this.retryAt - now);
            return false;
        }
        if (!this.deps.isIdle()) return false;
        this.busy = true;
        this.arrivedDuringDispatch.clear();
        try {
            const outcome = await this.deps.dispatch();
            switch (outcome.kind) {
                case 'dispatched': {
                    this.failures = 0;
                    const alreadyRouted = this.arrivedDuringDispatch.delete(outcome.localId);
                    if (!alreadyRouted) {
                        this.inflight = { localId: outcome.localId, since: this.now() };
                        // A lost socket must not leave the queue parked: re-check at expiry.
                        this.schedule(() => { void this.maybeDispatch('inflight-timeout'); }, this.inflightTimeoutMs + 1);
                    }
                    this.log(`[prompt-queue] dispatched ${outcome.localId} (${reason}${alreadyRouted ? ', already routed' : ''})`);
                    return true;
                }
                case 'empty':
                    this.failures = 0;
                    return false;
                case 'unsupported':
                    this.disabled = true;
                    this.log('[prompt-queue] server has no prompt queue; drain disabled for this process');
                    return false;
                case 'error': {
                    this.failures += 1;
                    const delay = Math.min(PROMPT_QUEUE_RETRY_MAX_MS, PROMPT_QUEUE_RETRY_MIN_MS * 2 ** (this.failures - 1));
                    this.retryAt = this.now() + delay;
                    this.log(`[prompt-queue] dispatch failed (${outcome.message}); retry in ${delay}ms`);
                    this.scheduleRetry(delay);
                    return false;
                }
            }
        } finally {
            this.busy = false;
            this.arrivedDuringDispatch.clear();
        }
    }

    private scheduleRetry(delayMs: number): void {
        if (this.retryScheduled || this.closed) return;
        this.retryScheduled = true;
        this.schedule(() => {
            this.retryScheduled = false;
            void this.maybeDispatch('retry');
        }, delayMs);
    }
}
