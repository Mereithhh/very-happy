/**
 * B-859b: wait for `ready`, but give up once a deadline has passed.
 *
 * The budget is fixed when the caller is created (module load), not per
 * call: bootstrap retries a failed restore three times, and a fresh timeout on
 * every attempt would stretch "wasm never comes up" to minutes on the splash.
 * After the deadline each call rejects at once — unless `ready` has settled by
 * then, in which case the late wasm still wins and the retry succeeds.
 *
 * B-859c: the budget only counts time the page could run — while the page is
 * hidden or frozen the clock stops and resumes where it left off. A tab
 * suspended for longer than the budget therefore wakes up with the rest of it,
 * instead of failing the first call at once and leaving only the retry
 * backoff (~4.3 s) for the wasm.
 */
export class ReadyTimeoutError extends Error {
    constructor(label: string, timeoutMs: number) {
        super(`${label} not ready after ${timeoutMs}ms`);
        this.name = 'ReadyTimeoutError';
    }
}

/** True while `error` (or the cause it wraps, e.g. SyncNotStartedError.reason) is a ReadyTimeoutError. */
export function isReadyTimeout(error: unknown): boolean {
    for (let e = error, depth = 0; e && typeof e === 'object' && depth < 5; depth++) {
        if (e instanceof ReadyTimeoutError || (e as { name?: unknown }).name === 'ReadyTimeoutError') return true;
        e = (e as { reason?: unknown }).reason ?? (e as { cause?: unknown }).cause;
    }
    return false;
}

/** When the budget clock must stand still, and how to hear that it changed. */
export interface PauseSignal {
    paused(): boolean;
    subscribe(onChange: () => void): () => void;
}

const NEVER_PAUSED: PauseSignal = { paused: () => false, subscribe: () => () => {} };

/**
 * Paused while `document.hidden` or between the Page Lifecycle `freeze` and
 * `resume` events (Chrome can freeze a page without hiding it first).
 */
export function documentPauseSignal(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): PauseSignal {
    if (!doc) return NEVER_PAUSED;
    let frozen = false;
    const listeners = new Set<() => void>();
    const notify = () => { for (const l of [...listeners]) l(); };
    doc.addEventListener('freeze', () => { frozen = true; notify(); });
    doc.addEventListener('resume', () => { frozen = false; notify(); });
    doc.addEventListener('visibilitychange', notify);
    return {
        paused: () => frozen || doc.hidden,
        subscribe(onChange) {
            listeners.add(onChange);
            return () => { listeners.delete(onChange); };
        },
    };
}

export function readyWithin(
    ready: Promise<unknown>,
    timeoutMs: number,
    label: string,
    now: () => number = Date.now,
    pause: PauseSignal = NEVER_PAUSED,
): () => Promise<void> {
    let settled = false;
    // Running time spent so far, plus the start of the current running stretch.
    let spent = 0;
    let runningSince: number | null = pause.paused() ? null : now();
    const elapsed = () => spent + (runningSince === null ? 0 : now() - runningSince);
    const waiters = new Set<() => void>();
    const unsubscribe = pause.subscribe(() => {
        if (pause.paused()) {
            if (runningSince !== null) { spent += now() - runningSince; runningSince = null; }
        } else if (runningSince === null) {
            runningSince = now();
        }
        for (const w of [...waiters]) w();
    });
    const done = () => { settled = true; unsubscribe(); };
    void ready.then(done, done);
    return () => {
        if (settled) return ready.then(() => undefined);
        if (elapsed() >= timeoutMs) return Promise.reject(new ReadyTimeoutError(label, timeoutMs));
        return new Promise<void>((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const finish = () => { clearTimeout(timer); waiters.delete(arm); };
            // (Re)arm for the rest of the budget; while paused, wait for the
            // next pause change instead (a frozen page runs no timers anyway).
            function arm() {
                clearTimeout(timer);
                timer = undefined;
                if (runningSince === null) return;
                const remaining = timeoutMs - elapsed();
                if (remaining <= 0) { finish(); reject(new ReadyTimeoutError(label, timeoutMs)); return; }
                timer = setTimeout(arm, remaining);
            }
            waiters.add(arm);
            arm();
            ready.then(
                () => { finish(); resolve(); },
                (e) => { finish(); reject(e); },
            );
        });
    };
}
