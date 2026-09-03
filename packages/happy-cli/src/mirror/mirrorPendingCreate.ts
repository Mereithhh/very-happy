/**
 * Terminal mirror (B-305) — retry policy for a shadow session that FAILED to
 * be created.
 *
 * The binding for a hand-typed `claude` can only ever be born from a single
 * `SessionStart` hook: one shot, at claude launch. `createBinding` then calls
 * `getOrCreateSession`, and that call can fail for reasons that have nothing
 * to do with this terminal:
 *
 *   - 429 from the account-wide session-state write-rate bucket. Session
 *     CREATION is charged against the same budget as every session's routine
 *     metadata churn, so a busy account (many terminals + SDK sessions) can
 *     starve out a mirror bind. Observed on mac-office 33 times over four
 *     days: `[MIRROR] hook handling failed … status code 429`.
 *   - any 4xx/5xx or a network blip while the relay is restarting.
 *
 * Before this module the failure was terminal AND silent: the exception was
 * caught and logged at debug level, nothing was persisted, and `reconcile`
 * could not help — `adoptPersisted` revives a PREVIOUSLY persisted record, and
 * a create that never succeeded leaves none. The user's terminal then ran
 * claude for hours with no structured-view toggle, with no way to get one back
 * short of restarting claude.
 *
 * So the failed hook event is kept and retried on the reconcile tick (every
 * ~10s, and already gated on `claudeConfident` — i.e. only while that pane is
 * still visibly running claude).
 *
 * Deliberately in-memory only: the failures worth surviving are second-to-
 * minute-scale server hiccups, and every observed one would have been repaired
 * on the first or second tick. A daemon restart inside the retry window loses
 * the pending create — the same claude keeps running unmirrored until it is
 * restarted. Persisting it would buy that rare case at the cost of a new
 * on-disk state file that can itself go stale; revisit only with evidence.
 */

import type { TerminalHookEvent } from './mirrorProtocol';

export interface PendingMirrorCreate {
    /** The hook event whose createBinding failed — replayed verbatim. */
    event: TerminalHookEvent;
    /** Failed attempts so far (1 after the original failure). */
    attempts: number;
    /** When the FIRST attempt for this claude session failed. */
    firstFailedAt: number;
    /** Earliest time the next attempt may run. */
    nextAttemptAt: number;
}

/**
 * Backoff between retries. Starts inside the one-minute window the server's
 * write-rate bucket refills on, then backs off so a genuinely broken account
 * (over the 500-session cap, say) is not hammered every tick.
 */
export const PENDING_CREATE_BACKOFF_MS = [10_000, 30_000, 60_000, 120_000, 300_000];

/**
 * Give up after this long. Long enough to outlast a relay restart or a rate
 * limit; short enough that a stale event is never replayed against a claude
 * conversation that has since moved on without us noticing.
 */
export const PENDING_CREATE_MAX_AGE_MS = 30 * 60_000;

export function backoffForAttempt(attempts: number): number {
    const index = Math.min(Math.max(attempts, 1), PENDING_CREATE_BACKOFF_MS.length) - 1;
    return PENDING_CREATE_BACKOFF_MS[index];
}

/** Record (or re-record) a failed create for this terminal. */
export function pendingCreateAfterFailure(
    previous: PendingMirrorCreate | undefined,
    event: TerminalHookEvent,
    now: number,
): PendingMirrorCreate {
    const sameConversation = previous?.event.claudeSessionId === event.claudeSessionId;
    const attempts = sameConversation ? previous!.attempts + 1 : 1;
    return {
        event,
        attempts,
        firstFailedAt: sameConversation ? previous!.firstFailedAt : now,
        nextAttemptAt: now + backoffForAttempt(attempts),
    };
}

export type PendingCreateDecision = 'retry' | 'wait' | 'drop';

/**
 * What the reconcile tick should do with a pending create. The caller has
 * already established that the pane is claude-confident and that no binding
 * exists for the terminal.
 */
export function planPendingCreate(pending: PendingMirrorCreate, now: number): PendingCreateDecision {
    if (now - pending.firstFailedAt >= PENDING_CREATE_MAX_AGE_MS) return 'drop';
    return now >= pending.nextAttemptAt ? 'retry' : 'wait';
}

/**
 * A hook event arriving for the same terminal supersedes a pending create:
 * a new SessionStart will register its own pending on failure, and a
 * SessionEnd for that same claude session means the process we were trying to
 * mirror is gone. A SessionEnd naming a DIFFERENT claude session is stale
 * (the /clear ordering is SessionEnd → SessionStart) and must not discard a
 * pending create for the newer conversation.
 */
export function pendingCreateSupersededBy(pending: PendingMirrorCreate, event: TerminalHookEvent): boolean {
    if (event.event === 'SessionStart') return true;
    return pending.event.claudeSessionId === event.claudeSessionId;
}
