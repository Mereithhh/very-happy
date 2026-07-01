/**
 * webPush — web-only background push via Service Worker + Web Push (VAPID).
 *
 * Companion to webNotifications.ts (foreground, tab-open notifications). This
 * module handles the *background* path: register a service worker, subscribe to
 * the push service with the server's VAPID public key, and report the
 * `PushSubscription` to the server as a `webpush:`-prefixed push token (reusing
 * the existing /v1/push-tokens API — the server partitions expo vs web tokens).
 *
 * Background pushes are delivered even when no tab is open. On iOS this only
 * works once the user has "Add to Home Screen"-installed the PWA (iOS 16.4+).
 */

import { Platform } from 'react-native';
import { MMKV } from '@/storage/mmkv-web';
import { AuthCredentials } from '@/auth/tokenStorage';
import { getServerUrl } from './serverConfig';
import { registerPushToken, unregisterPushToken } from './apiPush';
import { log } from '@/log';

const store = new MMKV({ id: 'web-push' });
const TOKEN_KEY = 'web-push-token';

export function isWebPushSupported(): boolean {
    return (
        Platform.OS === 'web' &&
        typeof navigator !== 'undefined' &&
        'serviceWorker' in navigator &&
        typeof window !== 'undefined' &&
        'PushManager' in window &&
        typeof Notification !== 'undefined'
    );
}

function urlBase64ToUint8Array(base64url: string): Uint8Array {
    const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
    const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    // Back with an explicit ArrayBuffer so the type is Uint8Array<ArrayBuffer>,
    // which is what PushManager.subscribe's applicationServerKey expects.
    const out = new Uint8Array(new ArrayBuffer(raw.length));
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

async function fetchVapidPublicKey(): Promise<string | null> {
    try {
        const res = await fetch(`${getServerUrl()}/v1/web-push/vapid-public-key`);
        if (!res.ok) return null;
        const data = await res.json();
        return data?.configured && data?.publicKey ? (data.publicKey as string) : null;
    } catch {
        return null;
    }
}

async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
    try {
        await navigator.serviceWorker.register('/sw.js');
        return await navigator.serviceWorker.ready;
    } catch (e) {
        log.log('🔔 web push: SW register failed: ' + e);
        return null;
    }
}

function subToToken(sub: PushSubscription): string {
    return 'webpush:' + JSON.stringify(sub.toJSON());
}

async function ensureSubscription(): Promise<PushSubscription | null> {
    const reg = await registerServiceWorker();
    if (!reg) return null;
    const existing = await reg.pushManager.getSubscription();
    if (existing) return existing;
    const vapid = await fetchVapidPublicKey();
    if (!vapid) {
        log.log('🔔 web push: server has no VAPID key configured');
        return null;
    }
    try {
        return await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(vapid) as BufferSource,
        });
    } catch (e) {
        log.log('🔔 web push: subscribe failed: ' + e);
        return null;
    }
}

/**
 * Turn on background push. Assumes Notification permission is (or will be)
 * granted — flips it if undetermined. Returns true if a subscription was
 * registered with the server.
 */
export async function enableWebPush(credentials: AuthCredentials): Promise<boolean> {
    if (!isWebPushSupported()) return false;
    if (Notification.permission !== 'granted') {
        const p = await Notification.requestPermission();
        if (p !== 'granted') return false;
    }
    const sub = await ensureSubscription();
    if (!sub) return false;
    const token = subToToken(sub);
    try {
        await registerPushToken(credentials, token);
    } catch (e) {
        log.log('🔔 web push: registerPushToken failed: ' + e);
        return false;
    }
    const prev = store.getString(TOKEN_KEY);
    store.set(TOKEN_KEY, token);
    if (prev && prev !== token) {
        try { await unregisterPushToken(credentials, prev); } catch { /* best-effort */ }
    }
    return true;
}

/** Turn off background push: unsubscribe locally and drop the server token. */
export async function disableWebPush(credentials: AuthCredentials): Promise<void> {
    const prev = store.getString(TOKEN_KEY);
    try {
        if (isWebPushSupported()) {
            const reg = await navigator.serviceWorker.getRegistration();
            const sub = reg ? await reg.pushManager.getSubscription() : null;
            if (sub) await sub.unsubscribe();
        }
    } catch { /* best-effort */ }
    if (prev) {
        try { await unregisterPushToken(credentials, prev); } catch { /* best-effort */ }
        store.delete(TOKEN_KEY);
    }
}

/**
 * Idempotent startup reconciliation: if the user previously opted in (permission
 * granted), make sure a current subscription exists and is reported to the
 * server. Push subscriptions can rotate; the server-side token can be pruned on
 * delivery failure — re-reporting on each authenticated load keeps them in sync.
 */
export async function syncWebPush(credentials: AuthCredentials): Promise<void> {
    if (!isWebPushSupported()) return;
    if (Notification.permission !== 'granted') return;
    try {
        const sub = await ensureSubscription();
        if (!sub) return;
        const token = subToToken(sub);
        await registerPushToken(credentials, token);
        const prev = store.getString(TOKEN_KEY);
        store.set(TOKEN_KEY, token);
        if (prev && prev !== token) {
            try { await unregisterPushToken(credentials, prev); } catch { /* best-effort */ }
        }
    } catch (e) {
        log.log('🔔 web push: syncWebPush failed: ' + e);
    }
}
