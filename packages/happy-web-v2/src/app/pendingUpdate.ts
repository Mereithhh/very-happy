/**
 * B-319 — a found update becomes an offer, not an ambush.
 *
 * It used to reload the moment it saw a newer shell. That is safe but it looks
 * broken: the page you were reading vanishes and comes back, with no
 * explanation, and users reported it as a bug.
 *
 * The reason it was unconditional still stands (see staleBundleReload): a tab
 * left running an old shell speaks an old protocol dialect, and one such client
 * resurrected a tmux session its user had deleted. So the update is not simply
 * left to the user's discretion — it is applied the moment doing so is
 * invisible. While the tab is in front of someone we ask; when it goes to the
 * background, or when nothing is on screen to lose, it applies itself.
 *
 * Net effect: nobody watches the page reload out from under them, and no tab
 * stays old for longer than it takes to look away.
 */
export type PendingUpdate = { entry: string };

type Listener = (pending: PendingUpdate | null) => void;

let pending: PendingUpdate | null = null;
const listeners = new Set<Listener>();

export function getPendingUpdate(): PendingUpdate | null {
    return pending;
}

export function subscribePendingUpdate(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function setPendingUpdate(next: PendingUpdate | null): void {
    if (pending?.entry === next?.entry) return;
    pending = next;
    for (const listener of listeners) {
        try { listener(pending); } catch { /* a bad listener must not block the rest */ }
    }
}
