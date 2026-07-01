/**
 * notificationPrefs — web-only local preferences for foreground browser
 * Notifications. Modeled on serverConfig.ts: a dedicated MMKV instance that
 * persists independently of synced settings (these are device/browser-local,
 * never synced — they describe *this* tab's notification behaviour).
 *
 * Holds: a master enable flag, per-notification-type toggles, and an optional
 * "do not disturb" quiet-hours window. The actual OS permission grant is
 * tracked by the browser; we only persist the user's intent here.
 */

import { MMKV } from '@/storage/mmkv-web';
import * as React from 'react';
import type { NotifType } from './feedTypes';

const store = new MMKV({ id: 'notification-prefs' });
const KEY = 'web-notification-prefs';

export interface QuietHours {
    enabled: boolean;
    /** Minutes from midnight, local time. e.g. 22:00 → 1320. */
    startMinute: number;
    /** Minutes from midnight, local time. e.g. 08:00 → 480. */
    endMinute: number;
}

export interface NotificationPrefs {
    /** Master switch — when off, no browser Notification is ever shown. */
    enabled: boolean;
    /** Per-type opt-in. Default: all on once enabled. */
    types: Record<NotifType, boolean>;
    quietHours: QuietHours;
}

export const DEFAULT_PREFS: NotificationPrefs = {
    enabled: false,
    types: {
        permission_request: true,
        reply_done: true,
        input_needed: true,
        error: true,
    },
    quietHours: {
        enabled: false,
        startMinute: 22 * 60, // 22:00
        endMinute: 8 * 60,    // 08:00
    },
};

function clampMinute(v: unknown): number | null {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    const n = Math.round(v);
    return n >= 0 && n < 24 * 60 ? n : null;
}

function parsePrefs(raw: string | undefined): NotificationPrefs {
    if (!raw) return { ...DEFAULT_PREFS };
    try {
        const obj = JSON.parse(raw);
        const types = obj?.types ?? {};
        const qh = obj?.quietHours ?? {};
        return {
            enabled: typeof obj?.enabled === 'boolean' ? obj.enabled : DEFAULT_PREFS.enabled,
            types: {
                permission_request: typeof types.permission_request === 'boolean' ? types.permission_request : DEFAULT_PREFS.types.permission_request,
                reply_done: typeof types.reply_done === 'boolean' ? types.reply_done : DEFAULT_PREFS.types.reply_done,
                input_needed: typeof types.input_needed === 'boolean' ? types.input_needed : DEFAULT_PREFS.types.input_needed,
                error: typeof types.error === 'boolean' ? types.error : DEFAULT_PREFS.types.error,
            },
            quietHours: {
                enabled: typeof qh.enabled === 'boolean' ? qh.enabled : DEFAULT_PREFS.quietHours.enabled,
                startMinute: clampMinute(qh.startMinute) ?? DEFAULT_PREFS.quietHours.startMinute,
                endMinute: clampMinute(qh.endMinute) ?? DEFAULT_PREFS.quietHours.endMinute,
            },
        };
    } catch {
        return { ...DEFAULT_PREFS };
    }
}

// Cached snapshot so useSyncExternalStore's getSnapshot returns a STABLE
// reference when the underlying value is unchanged. Returning a fresh object
// every call caused an infinite render loop (React error #185).
let _cachedRaw: string | undefined | null = null; // null = never read
let _cachedPrefs: NotificationPrefs = DEFAULT_PREFS;

export function getNotificationPrefs(): NotificationPrefs {
    const raw = store.getString(KEY);
    if (raw !== _cachedRaw) {
        _cachedRaw = raw;
        _cachedPrefs = parsePrefs(raw);
    }
    return _cachedPrefs;
}

// --- Lightweight subscription so React + the notifier stay in sync ---
const listeners = new Set<() => void>();

function emit() {
    for (const l of listeners) l();
}

export function setNotificationPrefs(next: NotificationPrefs): void {
    store.set(KEY, JSON.stringify(next));
    emit();
}

export function updateNotificationPrefs(delta: Partial<NotificationPrefs>): NotificationPrefs {
    const next = { ...getNotificationPrefs(), ...delta } as NotificationPrefs;
    setNotificationPrefs(next);
    return next;
}

export function setTypeEnabled(type: NotifType, value: boolean): void {
    const cur = getNotificationPrefs();
    setNotificationPrefs({ ...cur, types: { ...cur.types, [type]: value } });
}

export function setQuietHours(delta: Partial<QuietHours>): void {
    const cur = getNotificationPrefs();
    setNotificationPrefs({ ...cur, quietHours: { ...cur.quietHours, ...delta } });
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => {
        listeners.delete(cb);
    };
}

/** Reactive accessor for components. */
export function useNotificationPrefs(): NotificationPrefs {
    return React.useSyncExternalStore(subscribe, getNotificationPrefs, getNotificationPrefs);
}

/**
 * True if `now` falls inside the configured quiet-hours window. Handles
 * windows that wrap past midnight (e.g. 22:00 → 08:00).
 */
export function isWithinQuietHours(prefs: NotificationPrefs, now: Date = new Date()): boolean {
    const { quietHours } = prefs;
    if (!quietHours.enabled) return false;
    const cur = now.getHours() * 60 + now.getMinutes();
    const { startMinute: s, endMinute: e } = quietHours;
    if (s === e) return false;
    return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

/** Whether a notification of `type` should surface as a browser Notification. */
export function shouldNotify(type: NotifType, prefs: NotificationPrefs = getNotificationPrefs(), now: Date = new Date()): boolean {
    if (!prefs.enabled) return false;
    if (!prefs.types[type]) return false;
    if (isWithinQuietHours(prefs, now)) return false;
    return true;
}

export function formatMinute(minute: number): string {
    const h = Math.floor(minute / 60) % 24;
    const m = minute % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}
