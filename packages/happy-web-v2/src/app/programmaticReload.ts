/**
 * "We are reloading on purpose" flag.
 *
 * The tab-close guard (beforeunload, see ./viewShortcuts.ts) would otherwise
 * interrupt OUR OWN reloads: the stale-bundle auto-update, the vite:preloadError
 * recovery in main.tsx and the logout reload all call `window.location.reload()`,
 * and a browser leave-site dialog in front of those breaks the auto-update chain
 * (a user who clicks "stay" keeps running the zombie bundle we are trying to
 * retire — the exact failure staleBundleReload exists to prevent).
 *
 * Time-boxed instead of sticky: if the reload somehow never happens (a thrown
 * error, a blocked navigation), the guard re-arms itself instead of staying off
 * for the rest of the session. Kept in its own dependency-free module so the
 * reload call sites (main.tsx, AuthContext) don't drag in app code.
 */

export const PROGRAMMATIC_RELOAD_WINDOW_MS = 30_000;

let armedUntil = 0;

/** Call immediately before `window.location.reload()` (or any deliberate
 *  navigation away that must not be second-guessed). */
export function markProgrammaticReload(now: number = Date.now()): void {
  armedUntil = now + PROGRAMMATIC_RELOAD_WINDOW_MS;
}

export function isProgrammaticReloadPending(now: number = Date.now()): boolean {
  return now < armedUntil;
}

/** Test seam / explicit stand-down. */
export function resetProgrammaticReload(): void {
  armedUntil = 0;
}
