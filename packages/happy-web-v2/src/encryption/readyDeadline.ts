/**
 * B-859b: wait for `ready`, but give up once an absolute deadline has passed.
 *
 * The deadline is fixed when the caller is created (module load), not per
 * call: bootstrap retries a failed restore three times, and a fresh timeout on
 * every attempt would stretch "wasm never comes up" to minutes on the splash.
 * After the deadline each call rejects at once — unless `ready` has settled by
 * then, in which case the late wasm still wins and the retry succeeds.
 */
export class ReadyTimeoutError extends Error {
    constructor(label: string, timeoutMs: number) {
        super(`${label} not ready after ${timeoutMs}ms`);
        this.name = 'ReadyTimeoutError';
    }
}

export function readyWithin(
    ready: Promise<unknown>,
    timeoutMs: number,
    label: string,
    now: () => number = Date.now,
): () => Promise<void> {
    const deadline = now() + timeoutMs;
    let settled = false;
    void ready.then(() => { settled = true; }, () => { settled = true; });
    return () => {
        if (settled) return ready.then(() => undefined);
        const remaining = deadline - now();
        if (remaining <= 0) return Promise.reject(new ReadyTimeoutError(label, timeoutMs));
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new ReadyTimeoutError(label, timeoutMs)), remaining);
            ready.then(
                () => { clearTimeout(timer); resolve(); },
                (e) => { clearTimeout(timer); reject(e); },
            );
        });
    };
}
