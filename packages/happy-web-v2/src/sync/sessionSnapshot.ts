/**
 * `/v1/sessions` is a durable snapshot and intentionally carries no ephemeral
 * agent-activity fields. Preserve a currently-known running state while
 * adapting that snapshot; realtime activity / turn lifecycle events remain
 * authoritative and still flow through storage.applySessions unchanged.
 */
export function preserveSessionActivityFromStore<T extends { id: string; thinking: boolean; thinkingAt: number }>(
    snapshot: T,
    current: { thinking?: boolean; thinkingAt?: number } | undefined,
): T {
    if (current?.thinking !== true) return snapshot;
    return {
        ...snapshot,
        thinking: true,
        thinkingAt: current.thinkingAt ?? snapshot.thinkingAt,
    };
}

/** Merge one durable fetch batch against one, immediately-current store snapshot. */
export function preserveSessionBatchActivityFromStore<T extends { id: string; thinking: boolean; thinkingAt: number }>(
    snapshots: T[],
    currentById: Record<string, { thinking?: boolean; thinkingAt?: number } | undefined>,
): T[] {
    return snapshots.map((snapshot) => preserveSessionActivityFromStore(snapshot, currentById[snapshot.id]));
}
