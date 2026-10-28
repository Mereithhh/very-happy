/**
 * B-715 — how this page load was entered. Captured once at module evaluation:
 * main.tsx imports this before presenceBoot, which strips the push-click
 * marker from the URL, and before the router rewrites anything.
 *
 * A deep link (a `?task=` team link, a push-notification tap, a connect link,
 * … — not a UI-state param like `?panel=`, B-842) brings the person to do one specific thing; the release-notes pager must
 * not stand in the way there (B-697). Those loads only show the sidebar entry;
 * the pager opens on the next ordinary load.
 */

/** Paths that are action links even without a query string. */
const ACTION_PATHS = ['/terminal/connect', '/machine/connect'];

/**
 * B-842: params that only record what the screen shows — the session aside
 * (`?panel=`, its sub-agent target `sub`, machine web panel `wp`), written
 * with `replace` while the person works (sessionPanelState.ts). A reload of
 * such a URL is an ordinary visit, not a link to act on: counting it as a deep
 * link meant a session page refreshed with its aside open never showed the
 * notes (Owner 10-28). Any other param is still an action (`?task=`, push
 * `vh_presence`, `?new=`, `?fromSession=`, `?cmd=`, `?review=` …).
 */
const UI_STATE_PARAMS = new Set(['panel', 'sub', 'wp']);

/** Pure: an action param (anything but UI state), or an action path, makes the load a deep link. */
export function isDeepLinkEntry(url: { pathname: string; search: string }, base = ''): boolean {
  for (const key of new URLSearchParams(url.search).keys()) {
    if (!UI_STATE_PARAMS.has(key)) return true;
  }
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
