/**
 * deferredCommit — B-566, "do it now, commit later, undo in between".
 *
 * Archive and mark-done used to be immediate (archive behind a confirm dialog,
 * done with no way back). Now the UI hides the row optimistically and the
 * server call waits out an undo window; Undo inside the window reverts locally
 * and nothing was ever sent. Pattern adapted from Orca's
 * activity-clear-completed.ts (MIT): deferred eviction flushed on pagehide.
 *
 * Rules (spec 2026-10-web-robustness-undo-presence):
 *  - the window lives at MODULE level, so navigating to another session does
 *    not cancel or hurry it;
 *  - leaving the page commits immediately: pagehide, beforeunload and
 *    visibilitychange→hidden (a backgrounded iOS PWA can be killed without
 *    pagehide, and a frozen page's timers never fire). This is a COMMIT path,
 *    not a resume path — it does not touch resumeSync/checkLiveness (rule 13);
 *  - commit runs at most once; undo after commit returns false.
 */

export type FlushReason = 'timeout' | 'pagehide' | 'beforeunload' | 'hidden' | 'manual';

/** reasons that MAY outlive the page — send with fetch keepalive */
export function isUnloadFlush(reason: FlushReason): boolean {
    return reason === 'pagehide' || reason === 'beforeunload' || reason === 'hidden';
}

/** only a real teardown: the page is gone, no UI can report a failure. A
 *  hidden tab and a cancellable beforeunload are still alive — failures
 *  there must still roll the row back AND say why. */
export function isPageExitFlush(reason: FlushReason): boolean {
    return reason === 'pagehide';
}

export interface DeferredSpec {
    delayMs: number;
    /** the real (server) action; errors are the caller's to surface */
    commit: (reason: FlushReason) => void | Promise<void>;
    /** undo the optimistic local change */
    revert: () => void;
}

export interface DeferredHandle {
    readonly key: string;
    /** true = reverted before commit; false = already committed or reverted */
    undo: () => boolean;
    /** 'pending' until it commits or is reverted (by this handle or queue.undo) */
    state: () => 'pending' | 'committed' | 'reverted';
    flush: (reason?: FlushReason) => void;
    isPending: () => boolean;
}

interface TimerDeps {
    setTimer: (fn: () => void, ms: number) => unknown;
    clearTimer: (handle: unknown) => void;
}

interface Entry {
    handle: DeferredHandle;
    timer: unknown;
    spec: DeferredSpec;
    setState: (s: 'committed' | 'reverted') => void;
}

export function createDeferredCommits(deps: TimerDeps) {
    const pending = new Map<string, Entry>();

    const run = (key: string, reason: FlushReason) => {
        const entry = pending.get(key);
        if (!entry) return;
        pending.delete(key);
        deps.clearTimer(entry.timer);
        entry.setState('committed');
        try {
            const result = entry.spec.commit(reason);
            if (result && typeof (result as Promise<void>).catch === 'function') {
                (result as Promise<void>).catch((error) => console.error(`[deferredCommit] ${key} failed`, error));
            }
        } catch (error) {
            console.error(`[deferredCommit] ${key} failed`, error);
        }
    };

    const schedule = (key: string, spec: DeferredSpec): DeferredHandle => {
        const existing = pending.get(key);
        if (existing) return existing.handle;
        let state: 'pending' | 'committed' | 'reverted' = 'pending';
        const handle: DeferredHandle = {
            key,
            undo: () => (pending.get(key)?.handle === handle ? undoKey(key) : false),
            state: () => state,
            flush: (reason: FlushReason = 'manual') => {
                if (pending.get(key)?.handle === handle) run(key, reason);
            },
            isPending: () => pending.get(key)?.handle === handle,
        };
        const timer = deps.setTimer(() => run(key, 'timeout'), spec.delayMs);
        pending.set(key, { handle, timer, spec, setState: (s) => { state = s; } });
        return handle;
    };

    function undoKey(key: string): boolean {
        const entry = pending.get(key);
        if (!entry) return false;
        pending.delete(key);
        deps.clearTimer(entry.timer);
        entry.setState('reverted');
        entry.spec.revert();
        return true;
    }

    return {
        schedule,
        isPending: (key: string) => pending.has(key),
        /** revert a pending item by key (any surface that re-uses the object) */
        undo: undoKey,
        pendingKeys: () => [...pending.keys()],
        /** commit everything now (page going away) */
        flushAll: (reason: FlushReason) => {
            for (const key of [...pending.keys()]) run(key, reason);
        },
    };
}

export type DeferredCommits = ReturnType<typeof createDeferredCommits>;

/** Key of a session's pending archive / mark-done (rowActions). */
export function archiveCommitKey(sessionId: string): string {
    return `archive:${sessionId}`;
}

/** The app-wide queue (archive / done). */
export const deferredCommits: DeferredCommits = createDeferredCommits({
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
});

/**
 * Wire page-exit flushing for `queue` (idempotent per queue). Returns an
 * uninstall function (tests).
 */
const installed = new WeakMap<DeferredCommits, () => void>();
export function installDeferredCommitFlush(
    queue: DeferredCommits = deferredCommits,
    win: Pick<Window, 'addEventListener' | 'removeEventListener'> | undefined = typeof window !== 'undefined' ? window : undefined,
    doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'> | undefined = typeof document !== 'undefined' ? document : undefined,
): () => void {
    const prior = installed.get(queue);
    if (prior) return prior;
    if (!win || !doc) return () => {};
    const onPageHide = () => queue.flushAll('pagehide');
    const onBeforeUnload = () => queue.flushAll('beforeunload');
    const onVisibility = () => {
        if (doc.visibilityState === 'hidden') queue.flushAll('hidden');
    };
    win.addEventListener('pagehide', onPageHide);
    win.addEventListener('beforeunload', onBeforeUnload);
    doc.addEventListener('visibilitychange', onVisibility);
    const uninstall = () => {
        win.removeEventListener('pagehide', onPageHide);
        win.removeEventListener('beforeunload', onBeforeUnload);
        doc.removeEventListener('visibilitychange', onVisibility);
        installed.delete(queue);
    };
    installed.set(queue, uninstall);
    return uninstall;
}
