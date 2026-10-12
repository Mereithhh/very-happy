/**
 * Device-local carrier for "mark as unread" (B-559). Pure rules live in
 * notificationUnreadMarks.ts. MMKV + useSyncExternalStore, same shape as
 * notificationReadState.ts. Deliberately NOT synced (spec non-goal).
 */
import * as React from 'react';
import { MMKV } from '@/storage/mmkv-web';
import { parseUnreadMarks, withMark, withoutMark, type UnreadMarks } from './notificationUnreadMarks';

const store = new MMKV({ id: 'notification-unread-marks' });
const KEY = 'marks-v1';
const listeners = new Set<() => void>();

let cachedRaw: string | undefined | null = null; // null = never read
let cached: UnreadMarks = {};

export function getUnreadMarks(): UnreadMarks {
    const raw = store.getString(KEY);
    if (raw !== cachedRaw) {
        cachedRaw = raw;
        try {
            cached = raw ? parseUnreadMarks(JSON.parse(raw)) : {};
        } catch {
            cached = {};
        }
    }
    return cached;
}

function write(next: UnreadMarks) {
    if (next === getUnreadMarks()) return;
    const raw = JSON.stringify(next);
    store.set(KEY, raw);
    cachedRaw = raw;
    cached = next;
    for (const l of listeners) l();
}

export function markEntryUnread(id: string, at: number = Date.now()): void {
    write(withMark(getUnreadMarks(), id, at));
}

export function clearUnreadMark(id: string): void {
    write(withoutMark(getUnreadMarks(), id));
}

export function clearAllUnreadMarks(): void {
    if (Object.keys(getUnreadMarks()).length > 0) write({});
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => {
        listeners.delete(cb);
    };
}

export function useUnreadMarks(): UnreadMarks {
    return React.useSyncExternalStore(subscribe, getUnreadMarks, getUnreadMarks);
}
