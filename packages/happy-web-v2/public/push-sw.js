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
    self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url },
    })
  );
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
