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
