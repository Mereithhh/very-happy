/**
 * LaunchModeGate — the launch-scoped answer to "was the running SDK Query
 * built for this message's mode?".
 *
 * A Claude SDK Query fixes its system prompts and tool policy at creation, so a
 * message whose mode differs from the one the live Query was built for has to be
 * parked and replayed into a fresh launch (claudeRemoteLauncher's `pending`).
 * The gate owns the two pieces of state that decision needs — the mode the
 * current launch adopted, and its hash.
 *
 * It exists as a module (rather than two bare `let`s in the launcher) because
 * that shape shipped a silent bug: the park-and-replay path returned the parked
 * message WITHOUT re-adopting its mode, so `modeHash` stayed null for the rest
 * of the launch. With a null hash the comparison short-circuits, and the NEXT
 * mode change was swallowed into a Query built for the previous message —
 * "switching the model does nothing", reproduced in mac-office daemon logs on
 * 2026-09-03 (a default→opus switch produced no `mode has changed` line and no
 * relaunch). The same null left `mode` unset, which makes the Steer handler
 * return false for the whole launch, silently degrading Steer to plain queueing.
 *
 * Adoption is therefore the ONLY way to arm the gate, and every path that hands
 * a message to the launch — first message, replayed pending, permission-mode
 * commit — goes through `adopt`.
 */
export class LaunchModeGate<M, P extends { mode: M } = { mode: M }> {
    private currentMode: M | null = null;
    private currentHash: string | null = null;
    private parked: P | null = null;

    constructor(private readonly hasher: (mode: M) => string) {}

    /** The mode this launch is running, or null before the first message. */
    get mode(): M | null {
        return this.currentMode;
    }

    /** Hash of {@link mode}; null means "not armed yet — accept anything". */
    get hash(): string | null {
        return this.currentHash;
    }

    /** Whether a message has been adopted into this launch yet. */
    get armed(): boolean {
        return this.currentHash !== null;
    }

    /** Bind the launch to `mode`. Idempotent; safe to call with the same mode. */
    adopt(mode: M): void {
        this.currentMode = mode;
        this.currentHash = this.hasher(mode);
    }

    /**
     * Re-adopt the current mode with one field replaced. No-op before the first
     * adopt: there is nothing to derive from, and arming here would make the
     * first real message look like a mode change.
     */
    amend(patch: Partial<M>): M | null {
        if (this.currentMode === null) return null;
        this.adopt({ ...this.currentMode, ...patch });
        return this.currentMode;
    }

    /**
     * True when `incomingHash` cannot run on this launch's Query and must be
     * parked for a fresh one. An un-armed gate accepts anything — that is how a
     * new launch takes its first message, including a replayed parked one.
     */
    requiresRelaunch(incomingHash: string, isolate?: boolean): boolean {
        if (isolate) return true;
        return this.armed && incomingHash !== this.currentHash;
    }

    /** True when `mode` is exactly what this launch adopted (Steer's precondition). */
    matches(mode: M): boolean {
        return this.armed && this.hasher(mode) === this.currentHash;
    }

    /**
     * Hold a message that cannot run on this launch until its successor picks
     * it up. Survives {@link reset} — the parked message is precisely what the
     * next launch exists to run.
     */
    park(message: P): void {
        this.parked = message;
    }

    /** Whether a parked message is waiting for the next launch. */
    get hasParked(): boolean {
        return this.parked !== null;
    }

    /**
     * Take the parked message AND adopt its mode in one step.
     *
     * This pairing is the whole point of the class. When parking and adopting
     * were separate — a `pending` variable in the launcher next to a `modeHash`
     * one — the replay path took the message and forgot to adopt, so the gate
     * stayed un-armed and swallowed the NEXT mode change into a Query built for
     * the previous one. Nothing structural tied the two, and no unit test could
     * reach the wiring. Here they cannot come apart.
     */
    takeParked(): P | null {
        const message = this.parked;
        if (!message) return null;
        this.parked = null;
        this.adopt(message.mode);
        return message;
    }

    /**
     * Re-adopt the parked message with a patched mode. Used when an explicit
     * mode switch lands while a message is parked: the switch is newer than the
     * snapshot the message carried when it was queued.
     */
    amendParked(patch: Partial<M>): void {
        if (!this.parked) return;
        this.parked = { ...this.parked, mode: { ...this.parked.mode, ...patch } };
    }

    /**
     * Drop back to un-armed. Called when a launch ends. Deliberately does NOT
     * clear a parked message: parking happens in the launch that is ending, and
     * the message belongs to the one about to start.
     */
    reset(): void {
        this.currentMode = null;
        this.currentHash = null;
    }
}
