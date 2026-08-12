/**
 * Stale-bundle auto-reload.
 *
 * Why this exists (field incident, 2026-08-13): a phone PWA that had not been
 * refreshed for a day reconnected and spoke an OLD protocol dialect — its
 * legacy create-or-attach `open-terminal` resurrected a tmux session the user
 * had deleted (new clients use attach-only semantics). Backward compatibility
 * on the daemon deliberately honors old clients, so the fix for the CLASS of
 * problems is to not let our own long-lived tabs/PWAs stay old: when the
 * server is serving a NEWER shell than the one running, reload.
 *
 * Mechanism: the shell's identity is the hashed entry script
 * (`/assets/index-<hash>-<salt>.js`). We fetch `/index.html` with a
 * cache-busting query — the query defeats both the HTTP cache and the
 * workbox precache match (its ignoreURLParametersMatching only covers utm_*)
 * so the response comes from the network — and compare the entry script name.
 * Mismatch → one guarded reload (plus a SW registration update so the next
 * shell comes from the new precache, mirroring the vite:preloadError guard in
 * main.tsx).
 *
 * Checks run when the page becomes visible and on a slow interval — a hidden
 * phone tab checks the moment it wakes up, which is exactly the zombie-client
 * scenario above.
 */

const ENTRY_RE = /\/assets\/(index-[A-Za-z0-9_-]+\.js)/;
const RELOAD_GUARD_KEY = 'vh-stale-bundle-reload-at';
const CHECK_INTERVAL_MS = 15 * 60_000;
const MIN_CHECK_GAP_MS = 60_000;

let lastCheckAt = 0;
let checking = false;

function ownEntryName(): string | null {
  const el = document.querySelector<HTMLScriptElement>('script[src*="/assets/index-"]');
  const m = el?.src.match(ENTRY_RE);
  return m ? m[1] : null;
}

async function serverEntryName(): Promise<string | null> {
  try {
    const res = await fetch(`/index.html?vh=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(ENTRY_RE);
    return m ? m[1] : null;
  } catch {
    return null; // offline / transient — never reload on uncertainty
  }
}

async function checkOnce(own: string): Promise<void> {
  if (checking) return;
  const now = Date.now();
  if (now - lastCheckAt < MIN_CHECK_GAP_MS) return;
  lastCheckAt = now;
  checking = true;
  try {
    const server = await serverEntryName();
    if (!server || server === own) return;
    // Reload-loop guard (same shape as the vite:preloadError guard): if we
    // reloaded recently and STILL mismatch, something is off — stay put.
    const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) || 0);
    if (now - last < 10 * 60_000) return;
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(now));
    try {
      const regs = await navigator.serviceWorker?.getRegistrations?.();
      await Promise.all((regs ?? []).map((r) => r.update().catch(() => {})));
    } catch {
      // SW update is best-effort; the reload below still fetches the new shell
    }
    window.location.reload();
  } finally {
    checking = false;
  }
}

/** Install the watcher. No-op outside a built bundle (dev server). */
export function installStaleBundleReload(): void {
  if (typeof document === 'undefined') return;
  const own = ownEntryName();
  if (!own) return; // vite dev / unexpected shell — nothing to compare
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void checkOnce(own);
  });
  setInterval(() => {
    if (!document.hidden) void checkOnce(own);
  }, CHECK_INTERVAL_MS);
  // First check shortly after load: a tab restored from the bfcache/session
  // restore can already be stale at startup.
  setTimeout(() => void checkOnce(own), 20_000);
}
