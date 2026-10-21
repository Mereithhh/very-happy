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
 * Payload contract (server app/push/pushDispatch.ts sendWeb):
 *   { title, body, data: { url?, sessionId?, kind?, ... },
 *     sentAt?: number,                 // B-569, server ms
 *     seen?: { [targetKey]: ms } }     // B-569, account read watermark subset
 *   data.url is an app path like /session/<id> or /terminal/<machineId>?tid=<id>.
 *   Old servers send neither sentAt nor seen → nothing is swept (old behavior).
 */

// ---------------------------------------------------------------------------
// B-569 — pure helpers (no SW globals; pushSwHygiene.test.ts runs this file
// in node:vm and calls them directly). Target keys share the web's key space
// (src/sync/notificationSeen.ts targetKeyOfPath): a session id, or
// `t:<terminalId>`.
// ---------------------------------------------------------------------------

/** App path → target key, or null. Same rules as targetKeyOfPath. */
function vhTargetKeyOfUrl(url) {
  if (typeof url !== 'string' || url.charAt(0) !== '/') return null;
  const q = url.indexOf('?');
  const path = q >= 0 ? url.slice(0, q) : url;
  const query = q >= 0 ? url.slice(q + 1) : '';
  const parts = path.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  if (parts[0] === 'session') {
    let id = parts[1];
    try { id = decodeURIComponent(id); } catch { /* keep raw */ }
    return id && id.indexOf('pending-') !== 0 ? id : null;
  }
  if (parts[0] === 'terminal') {
    const m = /(?:^|&)tid=([^&]*)/.exec(query);
    if (!m || !m[1]) return null;
    let tid = m[1];
    try { tid = decodeURIComponent(tid); } catch { /* keep raw */ }
    return tid ? 't:' + tid : null;
  }
  return null;
}

/** Target key of an incoming push: data.sessionId first, then data.url. */
function vhPushKey(data) {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.sessionId === 'string' && data.sessionId) return data.sessionId;
  return vhTargetKeyOfUrl(data.url);
}

/**
 * Notification tag: one live notification per target, the newer replaces the
 * older. `vh-test` for test pushes; null (no tag → old stacking behavior)
 * when the push names no target.
 */
function vhNotificationTag(payload) {
  const data = payload && payload.data;
  if (data && data.kind === 'test') return 'vh-test';
  const key = vhPushKey(data);
  if (!key) return null;
  return key.indexOf('t:') === 0 ? 'terminal:' + key.slice(2) : 'session:' + key;
}

/** Target key of a LIVE notification (ours, or one an older SW showed). */
function vhKeyOfNotification(n) {
  if (!n) return null;
  const tag = typeof n.tag === 'string' ? n.tag : '';
  if (tag.indexOf('session:') === 0 && tag.length > 8) return tag.slice(8);
  if (tag.indexOf('terminal:') === 0 && tag.length > 9) return 't:' + tag.slice(9);
  const data = n.data && typeof n.data === 'object' ? n.data : null;
  if (data && typeof data.key === 'string' && data.key) return data.key;
  return data ? vhTargetKeyOfUrl(data.url) : null;
}

/** When the notification's event happened (server sentAt, else show time). */
function vhNotificationCreatedAt(n) {
  const data = n && n.data && typeof n.data === 'object' ? n.data : null;
  if (data && typeof data.createdAt === 'number' && data.createdAt > 0) return data.createdAt;
  if (n && typeof n.timestamp === 'number' && n.timestamp > 0) return n.timestamp;
  return null;
}

/** Tolerant parse of payload.seen → { key: ms } (junk dropped). */
function vhParseSeen(x) {
  const out = {};
  if (!x || typeof x !== 'object' || Array.isArray(x)) return out;
  for (const key of Object.keys(x)) {
    const v = x[key];
    if (key && typeof v === 'number' && isFinite(v) && v > 0) out[key] = v;
  }
  return out;
}

/**
 * Live notifications the watermark already covers: the user opened that
 * target (on any device) at or after the notification's event. The incoming
 * push's own tag is never swept (device clock skew must not eat a new alert).
 */
function vhStaleNotifications(list, seen, exceptTag) {
  const out = [];
  for (const n of list || []) {
    if (exceptTag && n.tag === exceptTag) continue;
    const key = vhKeyOfNotification(n);
    if (!key || seen[key] === undefined) continue;
    const at = vhNotificationCreatedAt(n);
    if (at === null) continue;
    if (seen[key] >= at) out.push(n);
  }
  return out;
}

async function vhSweepSeen(rawSeen, exceptTag) {
  const seen = vhParseSeen(rawSeen);
  if (Object.keys(seen).length === 0) return 0;
  const reg = self.registration;
  if (!reg || typeof reg.getNotifications !== 'function') return 0;
  const stale = vhStaleNotifications(await reg.getNotifications(), seen, exceptTag);
  for (const n of stale) n.close();
  return stale.length;
}

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // Non-JSON push (should not happen) — still show something: iOS revokes
    // push permission from workers that swallow pushes silently.
  }
  if (!payload || typeof payload !== 'object') payload = {};
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const title = payload.title || 'Very Happy';
  const body = payload.body || '';
  const key = vhPushKey(data);
  // Old CLIs send no url; a session push can still deep-link.
  const url = data.url || (key && key.indexOf('t:') !== 0 ? '/session/' + encodeURIComponent(key) : '/');
  const tag = vhNotificationTag(payload);
  const createdAt = typeof payload.sentAt === 'number' && payload.sentAt > 0 ? payload.sentAt : Date.now();
  const options = {
    body,
    icon: '/icon-192.png',
    // Android tints the badge from its alpha only: a silhouette, not the colour tile.
    badge: '/badge-96.png',
    data: { url, key, kind: typeof data.kind === 'string' ? data.kind : undefined, createdAt },
  };
  if (tag) {
    // Same target → replace, but still alert: every push that reaches the SW
    // is one the server decided to deliver (it already suppresses while the
    // user is active). renotify without a tag throws, hence inside the if.
    options.tag = tag;
    options.renotify = true;
  }
  event.waitUntil(
    Promise.all([
      // Sweep first, then ALWAYS show: the sweep can never close this push's
      // own notification, and its failure never blocks it.
      vhSweepSeen(payload.seen, tag)
        .catch(() => 0)
        .then(() => self.registration.showNotification(title, options)),
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
// A report younger than VH_BADGE_FRESH_MS means a page is alive (even if
// hidden) and will publish the exact count itself — the SW then skips its +1
// estimate instead of double counting the same event.
// Stored in its own Cache (not workbox's precache, which workbox prunes).
// ---------------------------------------------------------------------------
const VH_BADGE_CACHE = 'vh-badge-v1';
const VH_BADGE_URL = '/__vh/badge-count';
const VH_BADGE_FRESH_MS = 10000;

// Stored as { count, at, from }: `from` = 'page' (a page reported it) or 'sw'
// (our own +1 estimate — not evidence that a page is alive).
async function readBadgeState() {
  const cache = await caches.open(VH_BADGE_CACHE);
  const res = await cache.match(VH_BADGE_URL);
  if (!res) return null;
  try {
    const s = JSON.parse(await res.text());
    const n = Number(s && s.count);
    if (!Number.isFinite(n) || n < 0) return null;
    return { count: Math.floor(n), at: Number(s.at) || 0, from: s.from === 'page' ? 'page' : 'sw' };
  } catch {
    return null;
  }
}

async function writeBadgeState(count, from) {
  const cache = await caches.open(VH_BADGE_CACHE);
  await cache.put(VH_BADGE_URL, new Response(JSON.stringify({ count, at: Date.now(), from })));
}

async function bumpAppBadge() {
  const nav = self.navigator;
  if (!nav || typeof nav.setAppBadge !== 'function') return;
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  // A visible page keeps the exact count itself (the inbox updates live).
  if (wins.some((c) => c.visibilityState === 'visible')) return;
  const last = await readBadgeState();
  if (last === null) {
    await nav.setAppBadge();
    return;
  }
  if (last.from === 'page' && Date.now() - last.at < VH_BADGE_FRESH_MS) return;
  const next = last.count + 1;
  await writeBadgeState(next, 'sw');
  await nav.setAppBadge(next);
}

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'vh-badge-count') return;
  const n = Number(msg.count);
  if (!Number.isFinite(n) || n < 0) return;
  event.waitUntil(writeBadgeState(Math.floor(n), 'page').catch(() => {}));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const rawUrl = (event.notification.data && event.notification.data.url) || '/';
  // B-567: the tap is a human gesture the page can't see — a one-shot marker
  // the page (src/app/presenceBoot.ts) turns into one presence input.
  const marked = new URL(rawUrl, self.location.origin);
  marked.searchParams.set('vh_presence', '1');
  const url = marked.origin === self.location.origin ? marked.pathname + marked.search + marked.hash : rawUrl;
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
