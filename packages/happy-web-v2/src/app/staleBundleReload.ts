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
 *
 * Every reload here is announced via markProgrammaticReload() so the tab-close
 * guard (beforeunload, ./viewShortcuts.ts) stands down: a leave-site dialog in
 * front of the update would let the user "stay" on the very zombie bundle this
 * module exists to retire.
 */
import { markProgrammaticReload } from '@/app/programmaticReload';
import {
  decideStaleBundleReload,
  serializeStaleBundleReloadGuard,
} from '@/app/staleBundlePolicy';

const ENTRY_RE = /\/assets\/(index-[A-Za-z0-9_-]+\.js)/;
const RELOAD_GUARD_KEY = 'vh-stale-bundle-reload-v2';
const CHECK_INTERVAL_MS = 15 * 60_000;
const MIN_CHECK_GAP_MS = 60_000;

let lastCheckAt = 0;
let checking = false;
let retryTimer: number | undefined;
let retryAt = 0;

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

function clearRetry(): void {
  if (retryTimer !== undefined) window.clearTimeout(retryTimer);
  retryTimer = undefined;
  retryAt = 0;
}

function scheduleRetry(own: string, retryAfterMs: number): void {
  const nextRetryAt = Date.now() + retryAfterMs;
  if (retryTimer !== undefined && retryAt <= nextRetryAt) return;
  clearRetry();
  retryAt = nextRetryAt;
  retryTimer = window.setTimeout(() => {
    retryTimer = undefined;
    retryAt = 0;
    if (!document.hidden) void checkOnce(own, true);
  }, Math.max(1_000, retryAfterMs + 100));
}

async function checkOnce(own: string, force = false): Promise<void> {
  if (checking) return;
  const now = Date.now();
  if (!force && now - lastCheckAt < MIN_CHECK_GAP_MS) return;
  lastCheckAt = now;
  checking = true;
  try {
    const server = await serverEntryName();
    if (!server) return;
    if (server === own) {
      clearRetry();
      sessionStorage.removeItem(RELOAD_GUARD_KEY);
      return;
    }
    // Only guard retries for the SAME target entry. A second deployment has a
    // different hashed entry and must update immediately instead of inheriting
    // the previous release's reload-loop window.
    const decision = decideStaleBundleReload(sessionStorage.getItem(RELOAD_GUARD_KEY), server, now);
    if (decision.action === 'wait') {
      scheduleRetry(own, decision.retryAfterMs);
      return;
    }
    clearRetry();
    sessionStorage.setItem(RELOAD_GUARD_KEY, serializeStaleBundleReloadGuard({
      entry: server,
      attemptedAt: now,
    }));
    try {
      const regs = await navigator.serviceWorker?.getRegistrations?.();
      await Promise.all((regs ?? []).map((r) => r.update().catch(() => {})));
    } catch {
      // SW update is best-effort; the reload below still fetches the new shell
    }
    markProgrammaticReload(); // don't let the unload guard block auto-update
    window.location.reload();
  } finally {
    checking = false;
  }
}

/** Manual check (Settings → Diagnostics "check for update" button).
 *  'updated' = a newer shell exists — a guarded reload has been triggered. */
export async function checkForUpdateNow(): Promise<'current' | 'updated' | 'unknown'> {
  const own = ownEntryName();
  if (!own) return 'unknown'; // dev server / unexpected shell
  const server = await serverEntryName();
  if (!server) return 'unknown';
  if (server === own) return 'current';
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.();
    await Promise.all((regs ?? []).map((r) => r.update().catch(() => {})));
  } catch { /* best-effort */ }
  // Manual check = explicit user intent: bypass the reload-loop guard window
  // but still stamp it so the automatic path stays throttled.
  sessionStorage.setItem(RELOAD_GUARD_KEY, serializeStaleBundleReloadGuard({
    entry: server,
    attemptedAt: Date.now(),
  }));
  markProgrammaticReload(); // explicit user intent — no leave-site dialog
  setTimeout(() => window.location.reload(), 600); // let the toast paint first
  return 'updated';
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
