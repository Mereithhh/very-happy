/**
 * The in-memory stand-in for the `AuthRateLimitBucket` UPSERT, shared by every
 * quota spec that fakes `$queryRawUnsafe`.
 *
 * It exists because eight specs had hand-rolled the same five lines, and when
 * B-307 changed the statement's contract — a refused request must update
 * nothing and return no row — all eight silently kept answering "allowed" and
 * had to be found by running them. One copy, one place to keep honest.
 *
 * Window expiry is deliberately not modelled: these specs run inside a single
 * window, and pretending otherwise would invite them to assert against a fake
 * clock instead of the real SQL (which
 * `authRateLimiterSelfLock.pglite.integration.spec.ts` covers on PGlite).
 */
export function applyFakeRateLimitBucket(
    counts: Map<string, number>,
    args: readonly unknown[],
): Array<{ count: number }> {
    const key = String(args[0]);
    const cost = Number(args[3] ?? 1);
    const max = Number(args[4]);
    const current = counts.get(key) ?? 0;
    const next = current + cost;
    if (Number.isFinite(max) && next > max) return [];
    counts.set(key, next);
    return [{ count: next }];
}
