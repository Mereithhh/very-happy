/**
 * B-356 — a reload only lands on the new shell if the NEW service worker is the
 * one that answers it.
 *
 * Field report (Owner, 2026-09-04): "提示有更新，点更新，页面刷新了，但刷新后没弹
 * changelog". The dialog was not broken — the page had not actually changed
 * shells. `index.html` is precached (`globPatterns: ['index.html']`) and every
 * navigation is answered by the controlling worker's `navigateFallback` route,
 * so `location.reload()` returns whatever shell the CURRENT controller has in
 * its precache, network be damned. `registration.update()` resolves when the
 * new worker finishes INSTALLING; activation and `clients.claim()` come later.
 * Reloading the instant it resolves is therefore a race the outgoing worker
 * usually wins: same entry script, same `CHANGELOG_RELEASES` head, no release
 * dialog — and because `applyUpdate` already stamped the reload guard, ten
 * silent minutes before anything tries again.
 *
 * So the update waits for `controllerchange`: the moment the new worker is the
 * one that will answer the navigation. Bounded, because B-328's rule stands —
 * the service worker step must never be able to hang the update.
 *
 * The two helpers here take structural interfaces rather than reaching for
 * globals so the rule is testable without a service worker (jsdom has none).
 */

export interface RegistrationLike {
  readonly installing: unknown;
  readonly waiting: unknown;
  update(): Promise<unknown>;
  addEventListener(type: 'updatefound', listener: () => void): void;
  removeEventListener(type: 'updatefound', listener: () => void): void;
}

export interface ContainerLike {
  getRegistrations(): Promise<readonly RegistrationLike[]>;
  addEventListener(type: 'controllerchange', listener: () => void): void;
  removeEventListener(type: 'controllerchange', listener: () => void): void;
}

export type TakeoverOutcome =
  /** No service worker at all (unsupported, blocked, or never registered). */
  | 'no-worker'
  /** Nothing new arrived — the worker in charge is already the current one. */
  | 'already-current'
  /** A new worker installed AND took control: a reload now gets the new shell. */
  | 'controlled'
  /** A new worker arrived but did not take control within the budget. */
  | 'timeout';

/**
 * Ask every registration to update and resolve once the new worker controls
 * this page. Never rejects: every outcome is reported, and the caller reloads
 * regardless — a stale shell is better than a page that never comes back.
 */
export async function takeNewServiceWorker(
  container: ContainerLike | undefined,
  budgetMs: number,
): Promise<TakeoverOutcome> {
  if (!container) return 'no-worker';
  let registrations: readonly RegistrationLike[];
  try {
    registrations = (await container.getRegistrations()) ?? [];
  } catch {
    return 'no-worker';
  }
  if (registrations.length === 0) return 'no-worker';

  let arriving = registrations.some((r) => r.installing || r.waiting);
  const onUpdateFound = () => { arriving = true; };
  for (const registration of registrations) registration.addEventListener('updatefound', onUpdateFound);

  // Subscribe BEFORE update(): with skipWaiting + clientsClaim the handover can
  // complete while update() is still settling, and a controllerchange missed
  // here would mean waiting out the whole budget for an event already fired.
  let took = false;
  let takeover = () => {};
  const controlled = new Promise<void>((resolve) => {
    takeover = () => { took = true; resolve(); };
    container.addEventListener('controllerchange', takeover);
  });

  try {
    await Promise.all(registrations.map((r) => r.update().catch(() => {})));
    // Control already changed hands: the next navigation is the new worker's,
    // whatever the registration's installing/waiting slots say now.
    if (took) return 'controlled';
    const pending = arriving || registrations.some((r) => r.installing || r.waiting);
    if (!pending) return 'already-current';
    return await raceBudget(controlled, budgetMs);
  } finally {
    for (const registration of registrations) registration.removeEventListener('updatefound', onUpdateFound);
    container.removeEventListener('controllerchange', takeover);
  }
}

function raceBudget(controlled: Promise<void>, budgetMs: number): Promise<TakeoverOutcome> {
  return new Promise<TakeoverOutcome>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), budgetMs);
    void controlled.then(() => {
      clearTimeout(timer);
      resolve('controlled');
    });
  });
}

export interface CacheLike {
  keys(): Promise<readonly { url: string }[]>;
  delete(request: { url: string }): Promise<boolean>;
}

export interface CacheStorageLike {
  keys(): Promise<readonly string[]>;
  open(name: string): Promise<CacheLike>;
}

const PRECACHE_NAME = /^workbox-precache/;

/**
 * Last resort for the 'timeout' outcome: drop the precached `index.html` so the
 * outgoing worker's precache route misses and falls through to the network
 * (workbox's PrecacheStrategy falls back to network by default). The shell then
 * comes from the server even though the stale worker is still answering, and
 * the incoming worker re-precaches it on its own activation.
 *
 * Only ever called on the path where a newer shell is already known to exist,
 * immediately before a reload — the brief window without an offline shell costs
 * less than being pinned to a shell the server has retired.
 */
export async function dropPrecachedShell(cacheStorage: CacheStorageLike | undefined): Promise<number> {
  if (!cacheStorage) return 0;
  let dropped = 0;
  try {
    for (const name of await cacheStorage.keys()) {
      if (!PRECACHE_NAME.test(name)) continue;
      const cache = await cacheStorage.open(name);
      for (const request of await cache.keys()) {
        if (!isShellUrl(request.url)) continue;
        if (await cache.delete(request)) dropped += 1;
      }
    }
  } catch {
    // Storage blocked or evicted mid-iteration — the reload still runs.
  }
  return dropped;
}

/** Precache keys carry a `?__WB_REVISION__=` salt, so match on the path only. */
function isShellUrl(url: string): boolean {
  try {
    const { pathname } = new URL(url, 'https://placeholder.invalid');
    return pathname === '/' || pathname.endsWith('/index.html');
  } catch {
    return false;
  }
}
