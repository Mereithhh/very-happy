/**
 * B-803b: a catch-up read that does not wait out dead pooled connections one
 * after another.
 *
 * After the phone slept, the connections the browser would reuse may be dead
 * (no FIN, no RST): over h2 (production) the one connection all reads share,
 * over HTTP/1.1 any number of pooled keep-alive ones. With only a deadline,
 * each dead one costs a full SYNC_READ_TIMEOUT_MS before the retry gets the
 * next connection.
 *
 * Hedging: if an attempt has not answered after `hedgeAfterMs` (a healthy
 * read answers in tens of ms), start another one in parallel on another
 * connection (hedgedRequestInit) and keep the first that succeeds; the rest
 * are aborted. A slow but live link is never cut short: every attempt keeps
 * its own full deadline. Only for idempotent reads.
 *
 * B-818: only until the first response headers. The attempt whose headers
 * arrive first (`init.onResponse`, wired through fetchWithDeadline) is
 * committed: no further hedge starts, the attempts still waiting are aborted,
 * and its outcome is the read's. A big body (the 1.8MB session list) is
 * downloading, not dead — hedges racing it for the same bandwidth meant none
 * finished on slow 4G (B-816 Q1).
 */

export const HEDGE_AFTER_MS = 2_000;
/** Up to 3 dead connections are skipped in ~3 × HEDGE_AFTER_MS. */
export const HEDGE_MAX_ATTEMPTS = 4;

/**
 * The request options of the two connection pools; both parts are
 * load-bearing (e2e):
 *  - `cache: 'no-store'`: Chrome lets one request per URL write the cache
 *    entry and parks every other GET of that URL behind it (the cache lock),
 *    so without it the hedges waited for the dead attempt's 10s deadline
 *    instead of taking another connection (POOL 17s → 5s).
 *  - `credentials: 'omit'` for the second pool: over h2 (production) all
 *    reads share ONE connection, and a plain hedge lands on the same dead
 *    session until Chrome's h2 PING gives up on it (~10s). The Fetch standard
 *    keys connection pools by credentials mode, so an omit request gets its
 *    own connection (--h2 B6 10.8s → 2.2s). Over HTTP/1.1 it is a second
 *    per-host pool. Our API authenticates with the Bearer header only; no
 *    cookie is needed.
 */
export type HedgePoolInit = Pick<RequestInit, 'cache' | 'credentials'>;
export function hedgePoolInit(pool: 0 | 1): HedgePoolInit {
    return pool === 1 ? { cache: 'no-store', credentials: 'omit' } : { cache: 'no-store' };
}
/** What an attempt spreads into its request: the pool, and the headers-arrived callback (B-818). */
export type HedgedRequestInit = HedgePoolInit & { onResponse: () => void };

/**
 * Attempts alternate pools, starting with the one whose attempt last won a
 * hedge: once the default pool's h2 session is dead, every later read
 * (another session's page, the reconnect catch-up, a live message's gap
 * fetch) goes to the live pool first instead of paying HEDGE_AFTER_MS again
 * until Chrome drops the dead session (--h2: B6 live-after-resume 2.4s, A4).
 * A later hedge won by the other pool switches back.
 */
let preferredPool: 0 | 1 = 0;
export function resetHedgePreference() { preferredPool = 0; }

export type HedgeOptions = {
    signal?: AbortSignal | null;
    hedgeAfterMs?: number;
    maxAttempts?: number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (timer: unknown) => void;
};

/**
 * Run `attempt` and hedge it. Resolves with the first attempt that fulfils.
 * Rejects when the caller's signal aborts, or when an attempt fails while no
 * other is running (the caller's backoff retries; a failing server is not
 * hammered with hedges).
 */
export function hedgedRead<T>(
    attempt: (signal: AbortSignal, init: HedgedRequestInit, index: number) => Promise<T>,
    opts: HedgeOptions = {},
): Promise<T> {
    const hedgeAfterMs = opts.hedgeAfterMs ?? HEDGE_AFTER_MS;
    const maxAttempts = Math.max(1, opts.maxAttempts ?? HEDGE_MAX_ATTEMPTS);
    const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = opts.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    const outer = opts.signal ?? null;
    if (outer?.aborted) return Promise.reject(outer.reason ?? new DOMException('Aborted', 'AbortError'));

    return new Promise<T>((resolve, reject) => {
        const controllers: AbortController[] = [];
        let running = 0;
        let settled = false;
        let timer: unknown = null;
        let committed: AbortController | null = null;

        const finish = () => {
            settled = true;
            if (timer !== null) clearTimer(timer);
            timer = null;
            outer?.removeEventListener('abort', onOuterAbort);
        };
        const abortAll = (reason: unknown, except?: AbortController) => {
            for (const controller of controllers) if (controller !== except) controller.abort(reason);
        };
        const onOuterAbort = () => {
            if (settled) return;
            finish();
            const reason = outer?.reason ?? new DOMException('Aborted', 'AbortError');
            abortAll(reason);
            reject(reason);
        };
        const commit = (controller: AbortController) => {
            if (settled || committed) return;
            committed = controller;
            if (timer !== null) clearTimer(timer);
            timer = null;
            abortAll(new DOMException('Superseded by a responding attempt', 'AbortError'), controller);
        };
        const schedule = () => {
            if (committed || controllers.length >= maxAttempts) return;
            timer = setTimer(() => {
                timer = null;
                if (!settled) launch();
            }, hedgeAfterMs);
        };
        const launch = () => {
            const controller = new AbortController();
            const index = controllers.length;
            const pool = ((index + preferredPool) % 2) as 0 | 1;
            controllers.push(controller);
            running += 1;
            let result: Promise<T>;
            try {
                result = attempt(controller.signal, { ...hedgePoolInit(pool), onResponse: () => commit(controller) }, index);
            } catch (error) {
                result = Promise.reject(error);
            }
            result.then(
                (value) => {
                    running -= 1;
                    if (settled) return;
                    if (index > 0) preferredPool = pool;
                    finish();
                    abortAll(new DOMException('Superseded by a hedged attempt', 'AbortError'), controller);
                    resolve(value);
                },
                (error) => {
                    running -= 1;
                    if (settled) return;
                    // Committed: only that attempt's outcome counts (the rest were aborted for it).
                    if (committed ? committed !== controller : running > 0) return;
                    finish();
                    reject(error);
                },
            );
            schedule();
        };

        outer?.addEventListener('abort', onOuterAbort, { once: true });
        launch();
    });
}
