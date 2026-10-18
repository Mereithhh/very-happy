import { withTimeout } from './utils/withTimeout';

/**
 * B-631: how long a stop/steer waits for Claude Code to acknowledge the
 * `interrupt` control request. The SDK applies no deadline of its own (Orca,
 * claude-agent-sdk-control-requests.ts), so a wedged CLI used to hold the stop
 * button forever; on timeout the launcher's existing fallback — the hard
 * AbortController abort — takes over.
 */
export const INTERRUPT_TIMEOUT_MS = 3000;

/** Session-local controller for interrupting one SDK turn without aborting its query. */
export function createTurnSteeringController(opts: { interruptTimeoutMs?: number } = {}) {
    const interruptTimeoutMs = opts.interruptTimeoutMs ?? INTERRUPT_TIMEOUT_MS;
    let interrupt: (() => Promise<void>) | null = null;
    let steering = false;
    // B-468: a stop-button interrupt in flight. The SDK answers it with an
    // ordinary `result` (is_error, "Request interrupted by user"); without this
    // flag that result read as a failed turn — an error push and NO transcript
    // marker, so a stopped turn looked like "nothing happened".
    let interrupting = false;

    const boundedInterrupt = (run: () => Promise<void>) => withTimeout(run(), interruptTimeoutMs, 'interrupt');

    return {
        setInterrupt(next: (() => Promise<void>) | null) {
            interrupt = next;
        },
        async steer(): Promise<boolean> {
            if (!interrupt) return false;
            steering = true;
            try {
                await boundedInterrupt(interrupt);
                return true;
            } catch (error) {
                steering = false;
                throw error;
            }
        },
        /**
         * Interrupt the current turn WITHOUT injecting a follow-up message —
         * used by the stop button. Like steer it keeps the streaming query
         * alive (same process, same claudeSessionId); unlike steer it does not
         * set the steering flag, so the turn simply ends and the query waits
         * for the next user message. Returns false when no query is attached.
         */
        async interruptTurn(): Promise<boolean> {
            if (!interrupt) return false;
            interrupting = true;
            try {
                await boundedInterrupt(interrupt);
                return true;
            } catch (error) {
                interrupting = false;
                throw error;
            }
        },
        consumeReady(): boolean {
            if (!steering) return false;
            steering = false;
            return true;
        },
        /** The next `result` belongs to a stop-button interrupt: close the
         *  turn as cancelled and say "Aborted by user", not "failed". */
        consumeInterrupted(): boolean {
            if (!interrupting) return false;
            interrupting = false;
            return true;
        },
        reset() {
            interrupt = null;
            steering = false;
            interrupting = false;
        },
    };
}
