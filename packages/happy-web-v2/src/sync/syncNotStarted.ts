/**
 * B-859: thrown by syncCreate/syncRestore when init failed BEFORE any side
 * effect (tracking, socket, subscriptions). The engine is untouched and the
 * init flag is cleared, so the same call can simply run again.
 */
export class SyncNotStartedError extends Error {
    readonly reason: unknown;

    constructor(reason: unknown) {
        super(`sync did not start: ${reason instanceof Error ? reason.message : String(reason)}`);
        this.name = 'SyncNotStartedError';
        this.reason = reason;
    }
}
