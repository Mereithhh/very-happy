/**
 * notificationReadState — tracks which notification feed items the user has
 * seen, so the inbox can highlight unread ones. We persist a single watermark:
 * the highest feed counter that has been marked as read. Any notification with
 * a counter above the watermark is "unread". This is cheap, monotonic, and
 * matches the feed's append-only counter model.
 *
 * The watermark serves "mark ALL read"; clicking ONE entry must not sweep the
 * ones above it, so a bounded per-id read set overlays the watermark: a feed
 * item is unread iff counter > watermark AND its id is not in the set.
 */

import { MMKV } from '@/storage/mmkv-web';
import * as React from 'react';

const store = new MMKV({ id: 'notification-read-state' });
const KEY = 'read-watermark-counter';
const IDS_KEY = 'read-item-ids';
/** bounded overlay — ids below the watermark are redundant, so a cap is safe */
const IDS_CAP = 800;

const listeners = new Set<() => void>();

function emit() {
    for (const l of listeners) l();
}

export function getReadWatermark(): number {
    return store.getNumber(KEY) ?? 0;
}

/** First-run guard: before this feature shipped the watermark was never
 *  written, so the whole feed HISTORY would count as unread on first open
 *  (an instant "9+" badge storm). The first sight of the feed baselines an
 *  UNSET watermark (distinct from an explicit 0) to the feed's current head —
 *  only events after that count. */
export function baselineWatermarkIfUnset(counter: number): void {
    if (store.getNumber(KEY) === undefined && counter > 0) {
        store.set(KEY, counter);
        emit();
    }
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

// --- per-item read overlay ---------------------------------------------------

// Cached stable snapshot (fresh Set per getSnapshot call would loop React —
// same pattern as notificationPrefs.ts).
let cachedIdsRaw: string | undefined | null = null; // null = never read
let cachedIds: ReadonlySet<string> = new Set();

function parseIds(raw: string | undefined): string[] {
    if (!raw) return [];
    try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
    } catch {
        return [];
    }
}

export function getReadFeedIds(): ReadonlySet<string> {
    const raw = store.getString(IDS_KEY);
    if (raw !== cachedIdsRaw) {
        cachedIdsRaw = raw;
        cachedIds = new Set(parseIds(raw));
    }
    return cachedIds;
}

/** Mark ONE feed item read without touching the watermark. */
export function markFeedItemRead(id: string): void {
    if (getReadFeedIds().has(id)) return;
    const ids = parseIds(store.getString(IDS_KEY));
    ids.push(id);
    const bounded = ids.length > IDS_CAP ? ids.slice(ids.length - IDS_CAP) : ids;
    const raw = JSON.stringify(bounded);
    store.set(IDS_KEY, raw);
    cachedIdsRaw = raw;
    cachedIds = new Set(bounded);
    emit();
}

export function useReadFeedIds(): ReadonlySet<string> {
    return React.useSyncExternalStore(subscribe, getReadFeedIds, getReadFeedIds);
}
