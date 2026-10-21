/**
 * B-723 (O5): where a `spawn-happy-session` request came from, sent as an
 * optional diagnostic field (old daemons ignore it; new ones log it through
 * happy-cli `summarizeSpawnSessionForLog`). An unexplained extra session can
 * then be traced to its entry point instead of guessed at. No ids or paths:
 * the route keeps its shape only.
 */
export type SpawnOrigin = { source: string; route: string; visible: boolean; gesture: boolean | null };

/** `/teams/64f8…?starting=1` → `/teams/:id` — keeps the route shape, drops ids. */
export function spawnRoutePattern(pathname: string): string {
  return pathname.split('/').map(segment => (segment.length >= 16 || /\d/.test(segment) ? ':id' : segment)).join('/').slice(0, 64) || '/';
}

export function currentSpawnOrigin(source: string | undefined): SpawnOrigin | undefined {
  if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  return { source: source ?? 'unknown', route: spawnRoutePattern(window.location.pathname), visible: document.visibilityState === 'visible', gesture: activation ? activation.isActive : null };
}

/**
 * B-723 (O5): the quick 「新会话」 path spawns at once with no first message,
 * so a call that is not the direct result of a click or key press (no
 * transient user activation) must not create a session — the caller opens the
 * configure dialog instead. Browsers without the API are trusted.
 */
export function hasUserGesture(nav: { userActivation?: { isActive: boolean } } | undefined): boolean {
  return !nav?.userActivation || nav.userActivation.isActive;
}
