/**
 * Selects the smallest application root that can serve the current route.
 *
 * `/welcome` is the stable marketing URL and stays public even when this
 * browser has account credentials. `/` deliberately keeps the established
 * behavior: anonymous visitors see the landing page, returning users enter
 * the workspace.
 */
export function shouldUsePublicRoot(routePath: string, hasStoredCredentials: boolean, landingEnabled = true): boolean {
  // Self-contained (no module-level constants): build/startupPreload.ts
  // inlines this function into index.html to pick which root to preload.
  // B-701: `/s/<linkId>` share links open the anonymous viewer even in a signed-in browser.
  const ALWAYS_PUBLIC_PATH = /^\/(?:welcome\/?$|s\/[^/]+\/?$)/;
  const ANONYMOUS_PUBLIC_PATH = /^\/(?:$|docs(?:\/|$)|privacy\/?$|terms\/?$)/;
  if (!landingEnabled && (/^\/welcome\/?$/.test(routePath) || /^\/?$/.test(routePath))) {
    // B-624: no marketing page — `/` and `/welcome` belong to the app root, which sends anonymous visitors to login.
    return false;
  }
  return ALWAYS_PUBLIC_PATH.test(routePath)
    || (!hasStoredCredentials && ANONYMOUS_PUBLIC_PATH.test(routePath));
}
