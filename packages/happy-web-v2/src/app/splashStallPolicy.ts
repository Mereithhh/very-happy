/**
 * B-315 — never leave a viewer staring at the boot splash.
 *
 * `dismissPrepaintSplashWhenRouteReady` waits on a MutationObserver until the
 * route stops rendering its loading marker. It had no timeout, so a route that
 * never resolves kept the splash up forever, and the only way out was a hard
 * refresh. That is reachable in a completely ordinary way: after a redeploy the
 * previous shell's hashed lazy chunks are gone from the server, so a client
 * still running that shell fails its dynamic import. `vite:preloadError`
 * recovers by reloading, but only once per 30s — once that budget is spent the
 * route stays suspended and the splash stays up.
 *
 * Recovery is staged, because the two failures need different answers:
 *
 * - **First stall**: assume a stale shell and reload once. The reload fetches
 *   the current index.html and its chunks, which is exactly what the manual
 *   hard refresh was doing by hand.
 * - **Stall again after that reload**: reloading is not working, so stop
 *   reloading. Dismiss the splash and let the app render whatever it can — a
 *   visible broken page can be reported and navigated away from; an eternal
 *   loading animation cannot.
 */
export const SPLASH_STALL_MS = 12_000;

export type SplashStallGuard = { attemptedAt: number };
export type SplashStallDecision = { action: 'reload' } | { action: 'reveal' };

export function parseSplashStallGuard(value: string | null): SplashStallGuard | null {
    if (!value) return null;
    try {
        const parsed = JSON.parse(value) as Partial<SplashStallGuard>;
        if (typeof parsed.attemptedAt !== 'number' || !Number.isFinite(parsed.attemptedAt)) return null;
        return { attemptedAt: parsed.attemptedAt };
    } catch {
        return null;
    }
}

export function serializeSplashStallGuard(guard: SplashStallGuard): string {
    return JSON.stringify(guard);
}

/**
 * The guard lives in sessionStorage, so it is per-tab and disappears when the
 * tab does — a genuinely broken deploy cannot trap a returning visitor in a
 * reload loop, and a user who opens a new tab gets a fresh recovery attempt.
 */
export function decideSplashStall(storedGuard: string | null): SplashStallDecision {
    return parseSplashStallGuard(storedGuard) ? { action: 'reveal' } : { action: 'reload' };
}
