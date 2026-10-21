/**
 * B-715 — how this page load was entered. Captured once at module evaluation:
 * main.tsx imports this before presenceBoot, which strips the push-click
 * marker from the URL, and before the router rewrites anything.
 *
 * A deep link (a `?task=` team link, a push-notification tap, a connect link,
 * …) brings the person to do one specific thing; the release-notes pager must
 * not stand in the way there (B-697). Those loads only show the sidebar entry;
 * the pager opens on the next ordinary load.
 */

/** Paths that are action links even without a query string. */
const ACTION_PATHS = ['/terminal/connect', '/machine/connect'];

/** Pure: any query string, or an action path, makes the load a deep link. */
export function isDeepLinkEntry(url: { pathname: string; search: string }, base = ''): boolean {
  if (url.search && url.search !== '?') return true;
  const path = base && url.pathname.startsWith(base) ? url.pathname.slice(base.length) || '/' : url.pathname;
  return ACTION_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

const BASE = (import.meta.env?.BASE_URL ?? '/').replace(/\/$/, '');
let deepLink = typeof window !== 'undefined' ? isDeepLinkEntry(window.location, BASE) : false;

export function enteredByDeepLink(): boolean {
  return deepLink;
}

/** test-only */
export function setEnteredByDeepLinkForTest(value: boolean): void {
  deepLink = value;
}
