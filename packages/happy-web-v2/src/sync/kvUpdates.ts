/**
 * kvUpdates — fan-out for the server's realtime `kv-batch-update` push.
 *
 * The server already broadcasts every account-KV mutation to all of that
 * account's user-scoped sockets (happy-server kvMutate → buildKVBatchUpdate),
 * and the client schema has always parsed it (apiTypes ApiKvBatchUpdateSchema)
 * — nobody was listening. sync.handleUpdate now hands the changes here so
 * KV-backed stores can react live instead of polling.
 *
 * Deliberately dumb: no decoding, no per-key routing, no ordering guarantees.
 * Subscribers filter by key themselves and MUST be idempotent — the sender's
 * own mutation is echoed back to it, and a socket gap can drop pushes entirely
 * (so a store still needs its own refetch path).
 */

export interface KvChange {
    key: string;
    /** base64 of the stored bytes, or null for a delete */
    value: string | null;
    version: number;
}

type KvChangesListener = (changes: readonly KvChange[]) => void;

const listeners = new Set<KvChangesListener>();

export function onKvChanges(listener: KvChangesListener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function dispatchKvChanges(changes: readonly KvChange[]): void {
    if (changes.length === 0) return;
    for (const listener of listeners) {
        try {
            listener(changes);
        } catch (e) {
            console.warn('[kvUpdates] listener failed', e);
        }
    }
}
