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
 * b631-scratch/probe): one turn is `running` → … → `result` → `idle`; no idle
 * before the first turn; a turn pre-empted by a `priority: 'now'` message ends
 * with a `result` that has NO idle after it (the follow-up's turn starts at
 * once). `requires_action` parks the turn on the user and is not an end.
 *
 * Why a counter and not "thinking at idle time": after `result(N)` the
 * wrapper asynchronously pulls the next message and flips thinking back to
 * true, and `idle(N)` may be read from the stream only after that push — read
 * naively it would end turn N+1. The counter depends on stream order alone:
 * a result precedes its own idle, and an idle precedes the next `running`.
 */

export type ClaudeSessionState = 'idle' | 'running' | 'requires_action';

/** What an `idle` frame means for the open turn. */
export type ClaudeIdleVerdict =
    /** No result ended this turn: the idle is its end. */
    | 'end'
    /** The idle that follows a result which already ended the turn. */
    | 'duplicate'
    /** No turn is open (startup, or a non-idle state). */
    | 'ignore';

export function readClaudeSessionState(message: unknown): ClaudeSessionState | null {
    const m = message as { type?: unknown; subtype?: unknown; state?: unknown } | null;
    if (!m || m.type !== 'system' || m.subtype !== 'session_state_changed') return null;
    return m.state === 'idle' || m.state === 'running' || m.state === 'requires_action' ? m.state : null;
}

export function createClaudeTurnTracker() {
    /** A user message was handed to the Query, or the CLI announced a turn, and no end was seen yet. */
    let open = false;
    /** Results seen whose idle has not arrived yet; a `running` says it never will. */
    let idleOwed = 0;

    return {
        get isOpen(): boolean { return open; },
        /** A prompt was pushed, or the CLI reported `init` for a turn. Idempotent. */
        begin(): void { open = true; },
        /** A `result` frame: true when it ends the open turn (the caller runs its turn-end), false when the turn already ended. */
        onResult(): boolean {
            if (!open) return false;
            open = false;
            idleOwed += 1;
            return true;
        },
        onSessionState(state: ClaudeSessionState): ClaudeIdleVerdict {
            if (state === 'running') {
                // The next turn is starting: an idle still owed for the previous
                // one can no longer come (idle precedes running in the stream).
                idleOwed = 0;
                open = true;
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
