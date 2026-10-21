/**
 * B-668: how long an authentication 429 asks the client to wait.
 *
 * Current servers send `retryAfter` (seconds) in the body and mirror it in the
 * standard `Retry-After` header for the LONGEST blocking limit. Old servers
 * send neither, and the copy then falls back to a generic "try again later" —
 * never a made-up "a minute" (a per-address daily cap can mean ~24 hours).
 */
export function retryAfterSecondsFromError(error: unknown): number | undefined {
    const response = (error as { response?: { data?: unknown; headers?: unknown } } | null | undefined)?.response;
    const body = response?.data as { retryAfter?: unknown } | undefined;
    const fromBody = positiveSeconds(body?.retryAfter);
    if (fromBody !== undefined) return fromBody;
    const headers = response?.headers as Record<string, unknown> | { get?: (name: string) => unknown } | undefined;
    const raw = typeof (headers as { get?: unknown })?.get === 'function'
        ? (headers as { get: (name: string) => unknown }).get('retry-after')
        : (headers as Record<string, unknown> | undefined)?.['retry-after'];
    // Only the delta-seconds form; an HTTP-date would need a trusted clock.
    return typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? positiveSeconds(Number(raw.trim())) : undefined;
}

function positiveSeconds(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined;
}

export type RetryAfterUnit = 'seconds' | 'minutes' | 'hours' | 'days';

/**
 * Rounds a wait to the unit a person reads: seconds under a minute, whole
 * minutes (rounded UP, so "8 minutes" never undershoots) under an hour, then
 * hours and days rounded to nearest — a 23 h 00 m 05 s lock reads "23 hours",
 * not a misleading "24". Never answers 0.
 */
export function retryAfterMagnitude(seconds: number): { unit: RetryAfterUnit; count: number } {
    const s = Math.max(1, Math.ceil(seconds));
    if (s < 60) return { unit: 'seconds', count: s };
    const minutes = Math.ceil(s / 60);
    if (minutes < 60) return { unit: 'minutes', count: minutes };
    const hours = Math.max(1, Math.round(s / 3600));
    if (hours < 48) return { unit: 'hours', count: hours };
    return { unit: 'days', count: Math.round(s / 86_400) };
}
