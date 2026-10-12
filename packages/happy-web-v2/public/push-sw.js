/**
 * Web Push handlers, importScripts'd into the workbox-generated service
 * worker (see vite.config.ts workbox.importScripts).
 *
 * Why this file exists: v2 moved to VitePWA generateSW, which emits a
 * precache-only worker — the hand-written push/notificationclick handlers of
 * the v1 sw.js were silently lost, so Web Push subscriptions delivered
 * encrypted pushes that never became visible notifications. These handlers
 * restore the visible half of the pipeline.
 *
 * Payload contract (server app/push/webPush.ts sendWebPush):
 *   { title, body, data: { url?, ... } }   — data.url is an app path like
 *   /session/<id> or /terminal/<machineId>?tid=<id>.
 */

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // Non-JSON push (should not happen) — still show something: iOS revokes
    // push permission from workers that swallow pushes silently.
  }
  const title = payload.title || 'Very Happy';
  const body = payload.body || '';
  const url = (payload.data && payload.data.url) || '/';
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, {
        body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: { url },
      }),
      // B-559: never allowed to reject — the notification above must show.
      bumpAppBadge().catch(() => {}),
    ])
  );
});

// ---------------------------------------------------------------------------
// B-559 — PWA app-icon badge while no window is visible.
//
// The page mirrors the inbox unread count to the Badging API itself
// (src/screens/notifications/AppBadgeSync.tsx) and reports it here via
// postMessage({ type: 'vh-badge-count', count }). The push payload carries no
// count (the server can't know per-device read state), so on a push with no
// visible window we take the last reported count + 1; never reported → a
// number-less badge flag. Opening the app replaces it with the exact count.
// Stored in its own Cache (not workbox's precache, which workbox prunes).
// ---------------------------------------------------------------------------
const VH_BADGE_CACHE = 'vh-badge-v1';
const VH_BADGE_URL = '/__vh/badge-count';

async function readBadgeCount() {
  const cache = await caches.open(VH_BADGE_CACHE);
  const res = await cache.match(VH_BADGE_URL);
  if (!res) return null;
  const n = Number(await res.text());
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

async function writeBadgeCount(n) {
  const cache = await caches.open(VH_BADGE_CACHE);
  await cache.put(VH_BADGE_URL, new Response(String(n)));
}

async function bumpAppBadge() {
  const nav = self.navigator;
  if (!nav || typeof nav.setAppBadge !== 'function') return;
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  // A visible page keeps the exact count itself (the inbox updates live).
  if (wins.some((c) => c.visibilityState === 'visible')) return;
  const last = await readBadgeCount();
  if (last === null) {
    await nav.setAppBadge();
    return;
  }
  const next = last + 1;
  await writeBadgeCount(next);
  await nav.setAppBadge(next);
}

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'vh-badge-count') return;
  const n = Number(msg.count);
  if (!Number.isFinite(n) || n < 0) return;
  event.waitUntil(writeBadgeCount(Math.floor(n)).catch(() => {}));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of wins) {
        // Reuse an existing window (the installed PWA) and steer it to the
        // target; opening a second window from a standalone PWA is jarring.
        if ('focus' in client) {
          await client.focus();
          if ('navigate' in client) {
            try { await client.navigate(url); } catch { /* cross-origin/detached — leave focused */ }
          }
          return;
        }
      }
      await self.clients.openWindow(url);
    })()
  );
});
