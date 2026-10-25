/**
 * B-803: a REST read must never wait forever. A tab that went to the
 * background with a GET in flight (or got a pooled keep-alive connection that
 * died while it slept) otherwise waits until the browser gives up on that
 * connection — 150–180s in Chrome (B-802 B3/B6), during which every catch-up
 * for that session queued behind it.
 *
 * B-818: two clocks, not one. `timeoutMs` bounds the wait for the response
 * (headers = first byte); once it is there, the body only has to keep moving:
 * `idleTimeoutMs` without a new byte aborts it. `response.json()` on a link
 * that dies mid-body hangs just the same as before the headers, so the body
 * stays bounded, but a 1.8MB session list over slow 4G (~9s at 200KB/s) is no
 * longer cut at 10s and retried forever (B-816 Q1). Dead-link recovery is
 * unchanged: a dead link never delivers headers.
 */

/**
 * Default for catch-up reads: messages (after/before_seq), sessions, prompt-queue
 * GET — the wait for the headers, and (B-818) the longest gap between body bytes.
 */
export const SYNC_READ_TIMEOUT_MS = 10_000;

export class RequestTimeoutError extends Error {
    readonly name = 'TimeoutError';
    constructor(readonly timeoutMs: number, readonly phase: 'response' | 'idle' = 'response') {
        super(phase === 'idle' ? `Response body stalled for ${timeoutMs}ms` : `Request timed out after ${timeoutMs}ms`);
    }
}

export type RequestDeadline = {
    signal: AbortSignal;
    /** Drop the timer and the caller-signal listener (call when the request failed early). */
    dispose: () => void;
    /** B-818: replace the running timer with a fresh `ms` idle one (watchBodyProgress, per chunk). */
    rearm: (ms: number) => void;
};

/**
 * One signal that aborts on the caller's signal OR after `timeoutMs`.
 * Hand-rolled instead of `AbortSignal.any/timeout` (iOS < 17.4 lacks `any`).
 */
export function createRequestDeadline(opts: { signal?: AbortSignal | null; timeoutMs?: number }): RequestDeadline {
    const controller = new AbortController();
    const outer = opts.signal ?? null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onOuterAbort = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        controller.abort(outer?.reason);
    };
    const dispose = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        outer?.removeEventListener('abort', onOuterAbort);
    };
    const arm = (ms: number, phase: 'response' | 'idle') => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            outer?.removeEventListener('abort', onOuterAbort);
            controller.abort(new RequestTimeoutError(ms, phase));
        }, ms);
    };
    const rearm = (ms: number) => arm(ms, 'idle');
    if (outer?.aborted) {
        controller.abort(outer.reason);
    } else {
        outer?.addEventListener('abort', onOuterAbort, { once: true });
        if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) arm(opts.timeoutMs, 'response');
    }
    return { signal: controller.signal, dispose, rearm };
}

/** B-818: request options of the bounded reads (fetchWithDeadline, apiSocket.request). */
export type DeadlineRequestInit = RequestInit & {
    /** Until the response headers arrive. Omitted: no deadline at all. */
    timeoutMs?: number;
    /** After the headers: longest gap between body bytes. Defaults to `timeoutMs`. */
    idleTimeoutMs?: number;
    /** Called once when the headers arrived (hedgedRead stops hedging). */
    onResponse?: () => void;
};

/** fetch with a deadline; rejects with the abort reason (RequestTimeoutError on timeout). */
export async function fetchWithDeadline(
    fetchImpl: typeof fetch,
    url: string,
    init: DeadlineRequestInit,
): Promise<Response> {
    const { timeoutMs, idleTimeoutMs, onResponse, signal, ...rest } = init;
    if (timeoutMs === undefined) {
        const response = await fetchImpl(url, { ...rest, signal });
        onResponse?.();
        return response;
    }
    const deadline = createRequestDeadline({ signal, timeoutMs });
    let response: Response;
    try {
        response = await raceAbort(fetchImpl(url, { ...rest, signal: deadline.signal }), deadline.signal);
    } catch (error) {
        deadline.dispose();
        throw error;
    }
    onResponse?.();
    return watchBodyProgress(response, deadline, idleTimeoutMs ?? timeoutMs);
}

/**
 * B-818: hand back a response whose body re-arms the deadline as an idle
 * timer on every chunk, and errors with the abort reason the moment the
 * deadline fires (even if the underlying body ignores the abort). Without a
 * readable body (a test double, an old engine) the response is returned as is
 * and the first timer keeps bounding it as a whole, as before B-818.
 */
export function watchBodyProgress(response: Response, deadline: RequestDeadline, idleTimeoutMs: number): Response {
    const body = response.body;
    if (!body || typeof ReadableStream === 'undefined' || typeof body.getReader !== 'function') return response;
    deadline.rearm(idleTimeoutMs);
    const reader = body.getReader();
    const signal = deadline.signal;
    let onAbort: (() => void) | null = null;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            onAbort = () => {
                try { controller.error(abortReason(signal)); } catch { /* already closed */ }
                reader.cancel(abortReason(signal)).catch(() => {});
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
        },
        async pull(controller) {
            let chunk: ReadableStreamReadResult<Uint8Array>;
            try {
                chunk = await reader.read();
            } catch (error) {
                if (signal.aborted) return; // already errored with the abort reason
                deadline.dispose();
                throw error;
            }
            if (signal.aborted) return;
            if (chunk.done) {
                deadline.dispose();
                if (onAbort) signal.removeEventListener('abort', onAbort);
                controller.close();
                return;
            }
            deadline.rearm(idleTimeoutMs);
            controller.enqueue(chunk.value);
        },
        cancel(reason) {
            deadline.dispose();
            if (onAbort) signal.removeEventListener('abort', onAbort);
            return reader.cancel(reason);
        },
    });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * Reject as soon as `signal` aborts even if `promise` ignores it (a fetch
 * polyfill, or a test double): the caller's await must end at the deadline.
 */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
        // B-803b: the caller already started `promise` (a fetch on this
        // aborted signal) — it rejects too; handle it, or a restart that lands
        // between the credentials read and the fetch surfaces as an unhandled
        // 「Superseded by restart」 page error.
        promise.catch(() => {});
        return Promise.reject(abortReason(signal));
    }
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
