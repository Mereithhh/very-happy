/**
 * B-516: the pending session page must be on screen ≤100 ms after "new chat".
 * From a non-session route the lazy SessionDetailScreen chunk would otherwise
 * be fetched on navigation, so the new-chat entries warm it on pointerdown and
 * the app shell warms it once when the browser is idle. Same module specifier
 * as AppRoot's lazy() import → Vite resolves both to the same chunk.
 */
let started: Promise<unknown> | null = null;

export function prefetchSessionDetail(): void {
    if (started) return;
    started = import('@/screens/session/SessionDetailScreen').catch(() => {
        started = null; // a failed fetch may be retried by the next gesture
    });
}

/** Warm the chunk when the main thread is idle (fallback: a short timeout). */
export function prefetchSessionDetailWhenIdle(): () => void {
    if (typeof window === 'undefined') return () => {};
    const w = window as Window & {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
        cancelIdleCallback?: (handle: number) => void;
    };
    if (w.requestIdleCallback) {
        const handle = w.requestIdleCallback(prefetchSessionDetail, { timeout: 5_000 });
        return () => w.cancelIdleCallback?.(handle);
    }
    const timer = setTimeout(prefetchSessionDetail, 2_000);
    return () => clearTimeout(timer);
}
