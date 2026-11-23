/**
 * B-264 restart circuit breaker (pure).
 *
 * A restart replaces a session's wrapper process with one running the current
 * CLI code. If the successor is STILL broken (e.g. the machine is genuinely
 * misconfigured, not just running old code), an unbounded restart would
 * retry-storm. This bounds restarts per session per daemon lifetime.
 *
 * Kept pure (no timers, no process state) so the policy is unit-testable in
 * isolation; the daemon holds the `Map<sessionId, count>` and consults these
 * functions. Counts are intentionally per-daemon-lifetime (a fresh daemon —
 * e.g. after an upgrade — resets them, which is the desired "give the new code
 * a clean shot" behavior).
 */

export const DEFAULT_MAX_RESTARTS = 3;

/**
 * B-850a: in-place restarts for an account switch (`agent-profile-bind`,
 * `account rm --force`) are the user's own action, not a crash loop: they have
 * their own count and a much higher bound, and never use up the 3 above.
 */
export const DEFAULT_MAX_ACCOUNT_RESTARTS = 50;

/**
 * B-962c: 「退出团队模式」 and 「恢复团队」 restart the lead in place (and a live member on a restore).
 * They are the user's own actions too: two per exit/restore round would use up the 3 above by the
 * second restore, so they get their own count with the account bound.
 */
export const DEFAULT_MAX_TEAM_MODE_RESTARTS = 50;

/** Which restart count a restart uses: the crash-loop guard, or one of the user-action counts. */
export type RestartBudget = 'manual' | 'account' | 'team-mode';
export function restartBudget(options: { account?: true; teamMode?: true } | undefined): { budget: RestartBudget; max: number } {
    if (options?.account) return { budget: 'account', max: DEFAULT_MAX_ACCOUNT_RESTARTS };
    if (options?.teamMode) return { budget: 'team-mode', max: DEFAULT_MAX_TEAM_MODE_RESTARTS };
    return { budget: 'manual', max: DEFAULT_MAX_RESTARTS };
}

export type RestartDecision =
    | { allowed: true; attempt: number }
    | { allowed: false; reason: string };

/**
 * Decide whether a restart may proceed given how many have already run for this
 * session. Does NOT mutate — the caller records the attempt via
 * `recordRestartAttempt` only once it actually spawns, so a pre-flight rejection
 * (not-tracked, etc.) doesn't burn a slot.
 */
export function decideRestart(
    priorAttempts: number,
    max: number = DEFAULT_MAX_RESTARTS,
): RestartDecision {
    if (priorAttempts >= max) {
        return {
            allowed: false,
            reason: `restart-limit: this session has already been restarted ${priorAttempts} time(s) this daemon session (max ${max}). Start a new session instead.`,
        };
    }
    return { allowed: true, attempt: priorAttempts + 1 };
}

/** Next count to store after a restart is actually attempted (spawn issued). */
export function recordRestartAttempt(priorAttempts: number): number {
    return priorAttempts + 1;
}
