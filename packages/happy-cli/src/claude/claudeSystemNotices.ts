/**
 * The system frames a person should see while a turn runs (B-631; approach from
 * Orca, src/main/claude/claude-api-retry-row.ts and claude-informational-row.ts;
 * wording after codexFailureText.describeCodexRetry).
 *
 * `system/api_retry`: the API refused (529 overloaded, 429 rate limit, 5xx) or
 * never answered, and Claude Code is sitting through a backoff. Without a line
 * the session just spins. One retry run can be ten attempts over minutes, so
 * the first attempt is persisted at once and later ones only every
 * `minIntervalMs` — the rest reach the terminal status line only.
 *
 * `system/informational`: only `level: 'warning'` (a UserPromptSubmit hook that
 * blocked the prompt, say) earns a row, in its own words; `info`, `notice`
 * (a hook's systemMessage) and `suggestion` are session chrome.
 */

export type ClaudeApiRetryFrame = {
    attempt?: unknown;
    max_retries?: unknown;
    retry_delay_ms?: unknown;
    error_status?: unknown;
    error?: unknown;
};

const int = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;

function delayText(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const seconds = ms / 1000;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

/** `Claude is retrying after HTTP 529 overloaded (attempt 2/10, next retry in 8s)` */
export function describeClaudeApiRetry(frame: ClaudeApiRetryFrame): string {
    const status = int(frame.error_status);
    const kind = typeof frame.error === 'string' && frame.error && frame.error !== 'unknown'
        ? frame.error.replace(/_/g, ' ')
        : '';
    // error_status is null for connection errors (timeouts) that had no response.
    const cause = status !== null ? `HTTP ${status}${kind ? ` ${kind}` : ''}` : 'a connection error';
    const attempt = int(frame.attempt);
    const max = int(frame.max_retries);
    const delay = int(frame.retry_delay_ms);
    const details: string[] = [];
    if (attempt !== null) details.push(`attempt ${attempt}${max !== null ? `/${max}` : ''}`);
    if (delay !== null && delay >= 0) details.push(`next retry in ${delayText(delay)}`);
    return `Claude is retrying after ${cause}${details.length ? ` (${details.join(', ')})` : ''}`;
}

export const API_RETRY_NOTICE_MIN_INTERVAL_MS = 60_000;

/**
 * Which retry frames become a persisted chat row. A frame whose attempt does
 * not follow the last one starts a new run (Orca createClaudeApiRetryRuns);
 * a run's first frame always persists, later ones only after `minIntervalMs`.
 */
export function createClaudeApiRetryGate(opts: { minIntervalMs?: number } = {}) {
    const minIntervalMs = opts.minIntervalMs ?? API_RETRY_NOTICE_MIN_INTERVAL_MS;
    let lastAttempt: number | null = null;
    let lastPersistedAt: number | null = null;
    return {
        /** True when this frame should be persisted. */
        observe(frame: ClaudeApiRetryFrame, now: number): boolean {
            const attempt = int(frame.attempt);
            const newRun = attempt !== null && (lastAttempt === null || attempt <= lastAttempt);
            if (attempt !== null) lastAttempt = attempt;
            if (newRun || lastPersistedAt === null || now - lastPersistedAt >= minIntervalMs) {
                lastPersistedAt = now;
                return true;
            }
            return false;
        },
        /** The turn ended: the next retry is a new run. */
        reset(): void {
            lastAttempt = null;
            lastPersistedAt = null;
        },
    };
}

export const INFORMATIONAL_MAX_CHARS = 500;

/** The row a warning-level informational frame writes; null for every other level and for an empty warning. */
export function describeClaudeInformational(frame: { level?: unknown; content?: unknown }): string | null {
    if (frame.level !== 'warning' || typeof frame.content !== 'string') return null;
    const text = frame.content.replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return text.length > INFORMATIONAL_MAX_CHARS ? `${text.slice(0, INFORMATIONAL_MAX_CHARS - 1)}…` : text;
}
