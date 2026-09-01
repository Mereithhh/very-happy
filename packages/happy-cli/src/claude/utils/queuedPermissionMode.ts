/**
 * B-262 batch 2 (B4): an explicit permission-mode switch (idle RPC, plan
 * approval, approve-with-mode) is newer than every message already sitting in
 * the queue — their `mode.permissionMode` snapshot was taken at enqueue time.
 * Without this rewrite the next queued message restarts the query with the
 * stale snapshot and silently pulls a freshly-yolo'd process back to plan.
 *
 * Pure: mutates the given queue items in place (MessageQueue2 exposes `queue`)
 * and returns how many were rewritten.
 */
export function rewriteQueuedPermissionMode<T extends { permissionMode?: unknown }>(
    queue: Array<{ mode: T; modeHash: string }>,
    hasher: (mode: T) => string,
    permissionMode: string,
): number {
    let rewritten = 0;
    for (const item of queue) {
        if (item.mode.permissionMode === permissionMode) continue;
        item.mode = { ...item.mode, permissionMode };
        item.modeHash = hasher(item.mode);
        rewritten += 1;
    }
    return rewritten;
}
