/**
 * B-803: a REST read must never wait forever. A tab that went to the
 * background with a GET in flight (or got a pooled keep-alive connection that
 * died while it slept) otherwise waits until the browser gives up on that
 * connection — 150–180s in Chrome (B-802 B3/B6), during which every catch-up
 * for that session queued behind it.
 *
 * The deadline covers headers AND body: the timer is not cleared when fetch
 * resolves, because `response.json()` on a dead link hangs just the same.
 * Aborting after the body was read is a no-op.
 */

/** Default for catch-up reads: messages (after/before_seq), sessions, prompt-queue GET. */
export const SYNC_READ_TIMEOUT_MS = 10_000;

export class RequestTimeoutError extends Error {
    readonly name = 'TimeoutError';
    constructor(readonly timeoutMs: number) {
        super(`Request timed out after ${timeoutMs}ms`);
    }
}

export type RequestDeadline = {
    signal: AbortSignal;
    /** Drop the timer and the caller-signal listener (call when the request failed early). */
    dispose: () => void;
};

/**
 * One signal that aborts on the caller's signal OR after `timeoutMs`.
 * Hand-rolled instead of `AbortSignal.any/timeout` (iOS < 17.4 lacks `any`).
 */
export function createRequestDeadline(opts: { signal?: AbortSignal | null; timeoutMs?: number }): RequestDeadline {
    const controller = new AbortController();
    const outer = opts.signal ?? null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onOuterAbort = () => controller.abort(outer?.reason);
    const dispose = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        outer?.removeEventListener('abort', onOuterAbort);
    };
    if (outer?.aborted) {
        controller.abort(outer.reason);
    } else {
        outer?.addEventListener('abort', onOuterAbort, { once: true });
        if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
            const timeoutMs = opts.timeoutMs;
            timer = setTimeout(() => {
                timer = null;
                outer?.removeEventListener('abort', onOuterAbort);
                controller.abort(new RequestTimeoutError(timeoutMs));
            }, timeoutMs);
        }
    }
    return { signal: controller.signal, dispose };
}

/** fetch with a deadline; rejects with the abort reason (RequestTimeoutError on timeout). */
export async function fetchWithDeadline(
    fetchImpl: typeof fetch,
    url: string,
    init: RequestInit & { timeoutMs?: number },
): Promise<Response> {
    const { timeoutMs, signal, ...rest } = init;
    if (timeoutMs === undefined) return fetchImpl(url, { ...rest, signal });
    const deadline = createRequestDeadline({ signal, timeoutMs });
    try {
        return await raceAbort(fetchImpl(url, { ...rest, signal: deadline.signal }), deadline.signal);
    } catch (error) {
        deadline.dispose();
        throw error;
    }
}

/**
 * Reject as soon as `signal` aborts even if `promise` ignores it (a fetch
 * polyfill, or a test double): the caller's await must end at the deadline.
 */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(abortReason(signal));
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(abortReason(signal));
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
            (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
        );
    });
}

function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException('Aborted', 'AbortError');
}
