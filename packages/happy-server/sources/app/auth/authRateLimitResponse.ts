import { z } from 'zod';
import { allowAuthRequest, authRateLimitRetryAfterSeconds, type AuthRateBucket } from './authRateLimiter';

/**
 * B-668: every authentication 429 tells the client when it may retry — the
 * body's `retryAfter` (seconds) for the web copy, and the standard
 * `Retry-After` header for anything else. `retryAfter` is optional so a
 * capacity refusal with no bucket behind it stays a valid response, and old
 * clients that only read `error` keep working.
 */
export const tooManyRequestsSchema = z.object({
    error: z.literal('too_many_requests'),
    retryAfter: z.number().int().positive().optional(),
});

export interface RateLimitDeps {
    consume?: typeof allowAuthRequest;
    retryAfter?: (buckets: ReadonlyArray<AuthRateBucket>) => Promise<number>;
}

/**
 * Charges `buckets` in order and stops at the first refusal, exactly like the
 * historical sequential consumer (a refused bucket must not let the cheaper
 * later buckets be spent). Returns null when admitted; otherwise the seconds
 * until the longest blocking bucket among ALL of `buckets` resets.
 */
export async function rateLimitRetryAfter(
    buckets: ReadonlyArray<AuthRateBucket>,
    deps: RateLimitDeps = {},
): Promise<number | null> {
    const consume = deps.consume ?? allowAuthRequest;
    for (const bucket of buckets) {
        const allowed = await consume(bucket.key, {
            max: bucket.max,
            windowMs: bucket.windowMs ?? 60_000,
            ...(bucket.cost === undefined ? {} : { cost: bucket.cost }),
        });
        if (!allowed) return (deps.retryAfter ?? authRateLimitRetryAfterSeconds)(buckets);
    }
    return null;
}

/**
 * Sets the standard `Retry-After` header on `reply` and returns the matching
 * 429 body, so a route keeps its typed `reply.code(429).send(...)`.
 */
export function tooManyRequests(
    reply: { header(name: string, value: string): unknown },
    retryAfterSeconds: number,
): z.infer<typeof tooManyRequestsSchema> {
    reply.header('retry-after', String(retryAfterSeconds));
    return { error: 'too_many_requests', retryAfter: retryAfterSeconds };
}
