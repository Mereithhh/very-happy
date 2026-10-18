/**
 * Race `promise` against a timer (B-631; lifted out of claudeRemote.ts where
 * it guarded warm-Query adoption since B-515).
 *
 * The SDK owns control-request correlation but applies no deadline (Orca,
 * claude-agent-sdk-control-requests.ts): an `interrupt`, `set_model` or
 * `set_permission_mode` sent to a wedged Claude Code waits forever, and the
 * stop button / RPC waits with it. Every live control request goes through
 * here with its own budget; what to do on a timeout is the caller's.
 *
 * A late rejection of the loser stays handled — an unhandled rejection
 * archives the session (Session.markAborting history).
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label?: string): Promise<T> {
    promise.catch(() => { /* handled by the race below or deliberately dropped after a timeout */ });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label ? `${label} ` : ''}timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}
