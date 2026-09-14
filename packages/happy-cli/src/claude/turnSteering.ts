/** Session-local controller for interrupting one SDK turn without aborting its query. */
export function createTurnSteeringController() {
    let interrupt: (() => Promise<void>) | null = null;
    let steering = false;
    // B-468: a stop-button interrupt in flight. The SDK answers it with an
    // ordinary `result` (is_error, "Request interrupted by user"); without this
    // flag that result read as a failed turn — an error push and NO transcript
    // marker, so a stopped turn looked like "nothing happened".
    let interrupting = false;

    return {
        setInterrupt(next: (() => Promise<void>) | null) {
            interrupt = next;
        },
        async steer(): Promise<boolean> {
            if (!interrupt) return false;
            steering = true;
            try {
                await interrupt();
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
                await interrupt();
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
