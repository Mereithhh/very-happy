/** Session-local controller for interrupting one SDK turn without aborting its query. */
export function createTurnSteeringController() {
    let interrupt: (() => Promise<void>) | null = null;
    let steering = false;

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
            await interrupt();
            return true;
        },
        consumeReady(): boolean {
            if (!steering) return false;
            steering = false;
            return true;
        },
        reset() {
            interrupt = null;
            steering = false;
        },
    };
}
