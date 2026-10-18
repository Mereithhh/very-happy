/**
 * When a remote Claude turn is over (B-631; approach from Orca,
 * src/main/claude/claude-session-state-turn-over.ts).
 *
 * `result` ends most turns. A turn that a fault stops before its result frame
 * — the model request threw, the CLI gave up — got no end at all: thinking
 * stayed true and the next queued message was never handed over, for the
 * life of the process. Claude Code's own statement that a turn is over is
 * `system/session_state_changed state=idle` ("fires after heldBackResult
 * flushes and the bg-agent do-while exits — authoritative turn-over signal",
 * sdk.d.ts). It reaches us only with CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS
 * set on the child (sdk/query.ts); without it the SDK consumes the frame.
 *
 * Measured against Claude Code 2.1.296 (2026-10-19, skills/tmp/vh-orca-lessons/
 * b631-scratch/probe): one turn is `running` → … → `init` → … → `result` →
 * `idle`; no idle before the first turn; a turn pre-empted by a
 * `priority: 'now'` message ends with a `result` that has NO idle after it
 * (the follow-up's turn starts at once). `requires_action` parks the turn on
 * the user and is not an end.
 *
 * Two distinctions carry the whole design:
 *
 *  - **Pushed is not announced.** The wrapper hands a prompt to the Query
 *    (`pushed`) some time before the CLI dequeues it and says so (`running`,
 *    then `init` → `announced`). The CLI's state notifier has several idle
 *    emitters and no same-state dedupe (a prompt settling after
 *    requires_action, a task-status subscription, decideIdleReport), so a
 *    stray idle can land in that window. Only an ANNOUNCED turn is ended by an
 *    idle; a pending prompt is left to the `running` that will come.
 *
 *  - **An idle owed to a result is not an end.** After `result(N)` the wrapper
 *    pulls the next message asynchronously, and `idle(N)` may be read from the
 *    stream only after that push. The counter depends on stream order alone:
 *    a result precedes its own idle, and an idle precedes the next `running`
 *    — so a `running` clears whatever is still owed (the pre-empted turn's
 *    result never gets its idle).
 */

export type ClaudeSessionState = 'idle' | 'running' | 'requires_action';

/** What an `idle` frame means for the open turn. */
export type ClaudeIdleVerdict =
    /** No result ended this announced turn: the idle is its end. */
    | 'end'
    /** The idle that follows a result which already ended the turn. */
    | 'duplicate'
    /** Nothing announced is running (startup, a pending prompt only, or a non-idle state). */
    | 'ignore';

export function readClaudeSessionState(message: unknown): ClaudeSessionState | null {
    const m = message as { type?: unknown; subtype?: unknown; state?: unknown } | null;
    if (!m || m.type !== 'system' || m.subtype !== 'session_state_changed') return null;
    return m.state === 'idle' || m.state === 'running' || m.state === 'requires_action' ? m.state : null;
}

export function createClaudeTurnTracker() {
    /** The wrapper handed a prompt to the Query and the CLI has not announced a turn for it yet. */
    let pending = false;
    /** The CLI announced a turn (`running` / `init`) that no result or idle has ended. */
    let open = false;
    /** Results seen whose idle has not arrived yet; a `running` says it never will. */
    let idleOwed = 0;

    return {
        get isOpen(): boolean { return open; },
        get isPending(): boolean { return pending; },
        /** A prompt was pushed into the Query. Not a turn yet: the CLI has to pick it up. */
        pushed(): void { pending = true; },
        /** The CLI reported `init` for a turn: it is running. Idempotent. */
        announced(): void {
            open = true;
            pending = false;
        },
        /** A `result` frame: true when it ends the turn (the caller runs its turn-end), false when the turn already ended. */
        onResult(): boolean {
            if (!open && !pending) return false;
            open = false;
            pending = false;
            idleOwed += 1;
            return true;
        },
        onSessionState(state: ClaudeSessionState): ClaudeIdleVerdict {
            if (state === 'running') {
                // The next turn is starting: an idle still owed for the previous
                // one can no longer come (idle precedes running in the stream).
                idleOwed = 0;
                open = true;
                pending = false;
                return 'ignore';
            }
            if (state !== 'idle') return 'ignore';
            if (idleOwed > 0) {
                idleOwed -= 1;
                return 'duplicate';
            }
            if (!open) return 'ignore';
            open = false;
            return 'end';
        },
    };
}
