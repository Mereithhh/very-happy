/**
 * notificationReadState — tracks which notification feed items the user has
 * seen, so the inbox can highlight unread ones. We persist a single watermark:
 * the highest feed counter that has been marked as read. Any notification with
 * a counter above the watermark is "unread". This is cheap, monotonic, and
 * matches the feed's append-only counter model.
 */

import { MMKV } from 'react-native-mmkv';
import * as React from 'react';

const store = new MMKV({ id: 'notification-read-state' });
const KEY = 'read-watermark-counter';

const listeners = new Set<() => void>();

function emit() {
    for (const l of listeners) l();
}

export function getReadWatermark(): number {
    return store.getNumber(KEY) ?? 0;
}

/** Advance the watermark (only ever moves forward). */
export function markReadUpTo(counter: number): void {
    if (counter > getReadWatermark()) {
        store.set(KEY, counter);
        emit();
    }
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => {
        listeners.delete(cb);
    };
}

export function useReadWatermark(): number {
    return React.useSyncExternalStore(subscribe, getReadWatermark, getReadWatermark);
}
