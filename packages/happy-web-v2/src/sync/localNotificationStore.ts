/**
 * localNotificationStore — persistence for LOCALLY generated notification
 * entries (board lifecycle transitions — see notificationInbox.ts for the
 * derivation and useNotificationGenerator for the producer).
 *
 * Device-local on purpose (MMKV, like notificationPrefs/serverConfig): these
 * entries describe what THIS browser observed; the feed lane is the synced
 * one. Also holds the notification-center retention preference (days).
 *
 * The snapshot-caching pattern (stable reference for useSyncExternalStore)
 * follows notificationPrefs.ts — a fresh array per getSnapshot call would
 * loop React (error #185).
 */

import { MMKV } from '@/storage/mmkv-web';
import * as React from 'react';
import {
    dedupeAppend,
    pruneLocalEntries,
    type LocalNotifEntry,
} from './notificationInbox';

const store = new MMKV({ id: 'notification-center' });
const ENTRIES_KEY = 'local-entries-v1';
const RETENTION_KEY = 'retention-days';

/** repeats of the same key+kind inside this window are suppressed */
export const APPEND_DEDUPE_WINDOW_MS = 60_000;
/** hard cap on stored local entries (newest kept) */
export const LOCAL_ENTRIES_CAP = 200;

export const DEFAULT_RETENTION_DAYS = 7;
export const RETENTION_DAY_OPTIONS = [1, 3, 7, 30] as const;

const listeners = new Set<() => void>();
function emit() {
    for (const l of listeners) l();
}
function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => {
        listeners.delete(cb);
    };
}

// --- entries ---------------------------------------------------------------

let cachedRaw: string | undefined | null = null; // null = never read
let cachedEntries: LocalNotifEntry[] = [];

function parseEntries(raw: string | undefined): LocalNotifEntry[] {
    if (!raw) return [];
    try {
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return [];
        return arr.filter(
            (e): e is LocalNotifEntry =>
                !!e &&
                typeof e.id === 'string' &&
                typeof e.key === 'string' &&
                typeof e.kind === 'string' &&
                typeof e.href === 'string' &&
                typeof e.title === 'string' &&
                typeof e.createdAt === 'number' &&
                typeof e.read === 'boolean',
        );
    } catch {
        return [];
    }
}

export function getLocalEntries(): LocalNotifEntry[] {
    const raw = store.getString(ENTRIES_KEY);
    if (raw !== cachedRaw) {
        cachedRaw = raw;
        cachedEntries = parseEntries(raw);
    }
    return cachedEntries;
}

function writeEntries(entries: LocalNotifEntry[]): void {
    const raw = JSON.stringify(entries);
    store.set(ENTRIES_KEY, raw);
    cachedRaw = raw;
    cachedEntries = entries;
    emit();
}

/**
 * Append freshly derived entries (dedupe against recent repeats, then prune
 * by retention + cap). Returns the entries that were actually appended — the
 * caller plays the chime only for those.
 */
export function appendLocalEntries(incoming: LocalNotifEntry[]): LocalNotifEntry[] {
    if (incoming.length === 0) return [];
    const existing = getLocalEntries();
    const appended = dedupeAppend(existing, incoming, APPEND_DEDUPE_WINDOW_MS);
    if (appended.length === 0) return [];
    const next = pruneLocalEntries(
        [...existing, ...appended],
        Date.now(),
        getRetentionDays(),
        LOCAL_ENTRIES_CAP,
    );
    writeEntries(next);
    return appended;
}

export function markLocalRead(id: string): void {
    const entries = getLocalEntries();
    if (!entries.some((e) => e.id === id && !e.read)) return;
    writeEntries(entries.map((e) => (e.id === id ? { ...e, read: true } : e)));
}

export function markAllLocalRead(): void {
    const entries = getLocalEntries();
    if (!entries.some((e) => !e.read)) return;
    writeEntries(entries.map((e) => (e.read ? e : { ...e, read: true })));
}

export function useLocalEntries(): LocalNotifEntry[] {
    return React.useSyncExternalStore(subscribe, getLocalEntries, getLocalEntries);
}

// --- retention preference ---------------------------------------------------

export function getRetentionDays(): number {
    const v = store.getNumber(RETENTION_KEY);
    return typeof v === 'number' && v > 0 ? v : DEFAULT_RETENTION_DAYS;
}

export function setRetentionDays(days: number): void {
    store.set(RETENTION_KEY, days);
    // Prune immediately so shrinking the window is visible right away.
    const pruned = pruneLocalEntries(getLocalEntries(), Date.now(), days, LOCAL_ENTRIES_CAP);
    writeEntries(pruned);
}

export function useRetentionDays(): number {
    return React.useSyncExternalStore(subscribe, getRetentionDays, getRetentionDays);
}
