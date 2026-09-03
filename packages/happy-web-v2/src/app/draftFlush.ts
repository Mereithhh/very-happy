/**
 * B-315 — let an auto-update reload without eating what someone was typing.
 *
 * The composer persists its draft on a 400ms debounce and once more on unmount.
 * A programmatic `location.reload()` runs neither: React does not unmount on
 * navigation, and `markProgrammaticReload()` deliberately suppresses the unload
 * guard so there is no prompt either. Anything typed in the last debounce window
 * would simply be gone.
 *
 * The composer registers a flush here while it is mounted; the update path calls
 * it immediately before reloading. Callbacks must be synchronous — once the
 * reload starts, a promise will not be awaited.
 */
type DraftFlush = () => void;

const flushes = new Set<DraftFlush>();

export function registerDraftFlush(flush: DraftFlush): () => void {
    flushes.add(flush);
    return () => { flushes.delete(flush); };
}

/** Never throws: losing a draft is bad, blocking an update is worse. */
export function flushPendingDrafts(): void {
    for (const flush of flushes) {
        try { flush(); } catch { /* keep flushing the rest */ }
    }
}
