const ALWAYS_PUBLIC_PATH = /^\/welcome\/?$/;
const ANONYMOUS_PUBLIC_PATH = /^\/(?:$|docs(?:\/|$)|privacy\/?$|terms\/?$)/;

/**
 * Selects the smallest application root that can serve the current route.
 *
 * `/welcome` is the stable marketing URL and stays public even when this
 * browser has account credentials. `/` deliberately keeps the established
 * behavior: anonymous visitors see the landing page, returning users enter
 * the workspace.
 */
export function shouldUsePublicRoot(routePath: string, hasStoredCredentials: boolean): boolean {
  return ALWAYS_PUBLIC_PATH.test(routePath)
    || (!hasStoredCredentials && ANONYMOUS_PUBLIC_PATH.test(routePath));
}
