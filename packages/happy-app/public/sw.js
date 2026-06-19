/* Happy web push service worker.
 *
 * Self-hosted addition: receives Web Push messages (encrypted payload decrypted
 * by the browser, handed to us as JSON) and raises a notification even when no
 * tab is open. Clicking focuses an existing tab and navigates to the session,
 * or opens a new window.
 *
 * Kept intentionally minimal — no asset caching/offline logic. The app shell is
 * still served fresh from the network (Caddy no-store on HTML).
 */

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch (e) {
        payload = { title: 'Happy', body: event.data ? event.data.text() : '' };
    }
    const title = payload.title || 'Happy';
    const data = payload.data || {};
    const options = {
        body: payload.body || '',
        data,
        tag: data.sessionId || undefined,
        renotify: true,
        icon: '/favicon-active.ico',
        badge: '/favicon-active.ico',
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const data = event.notification.data || {};
    const sessionId = data.sessionId;
    const targetPath = sessionId ? '/session/' + sessionId : '/';
    event.waitUntil((async () => {
        const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of all) {
            if ('focus' in client) {
                await client.focus();
                if (sessionId && 'navigate' in client) {
                    try { await client.navigate(targetPath); } catch (e) { /* cross-origin / not allowed */ }
                }
                return;
            }
        }
        if (self.clients.openWindow) {
            await self.clients.openWindow(targetPath);
        }
    })());
});
