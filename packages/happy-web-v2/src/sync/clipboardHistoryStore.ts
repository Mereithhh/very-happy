/**
 * clipboardHistoryStore — persistence for clipboard-push history entries
 * (the web side of the copy_to_clipboard tool; producer in clipboardPush.ts).
 *
 * Device-local on purpose (MMKV, same pattern as localNotificationStore):
 * the entries describe what THIS browser received. Content may be sensitive
 * (the tool copies arbitrary text), hence the hard cap, per-entry delete and
 * the prominent clear-all — all list semantics live in clipboardHistory.ts
 * (pure, unit-tested).
 *
 * The snapshot-caching pattern (stable reference for useSyncExternalStore)
 * follows notificationPrefs.ts — a fresh array per getSnapshot call would
 * loop React (error #185).
 */

import { MMKV } from '@/storage/mmkv-web';
import * as React from 'react';
import {
    appendClipboardEntry,
    removeClipboardEntry,
    updateClipboardEntryText,
    isClipboardHistoryEntry,
    truncateForHistory,
    CLIPBOARD_HISTORY_CAP,
    type ClipboardHistoryEntry,
} from './clipboardHistory';

const store = new MMKV({ id: 'clipboard-history' });
const ENTRIES_KEY = 'entries-v1';

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

let cachedRaw: string | undefined | null = null; // null = never read
let cachedEntries: ClipboardHistoryEntry[] = [];

function parseEntries(raw: string | undefined): ClipboardHistoryEntry[] {
    if (!raw) return [];
    try {
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return [];
        return arr.filter(isClipboardHistoryEntry);
    } catch {
        return [];
    }
}

export function getClipboardHistory(): ClipboardHistoryEntry[] {
    const raw = store.getString(ENTRIES_KEY);
    if (raw !== cachedRaw) {
        cachedRaw = raw;
        cachedEntries = parseEntries(raw);
    }
    return cachedEntries;
}

function writeEntries(entries: ClipboardHistoryEntry[]): void {
    const raw = JSON.stringify(entries);
    store.set(ENTRIES_KEY, raw);
    cachedRaw = raw;
    cachedEntries = entries;
    emit();
}

let seq = 0;
function nextId(): string {
    // Local-only id — uniqueness within this device's history is enough.
    return `${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Record a received clipboard push (newest first, dedupe + cap). */
export function addClipboardHistoryEntry(
    text: string,
    source?: Pick<ClipboardHistoryEntry, 'sourceType' | 'sourceId' | 'sourceLabel'>,
): ClipboardHistoryEntry {
    const entry: ClipboardHistoryEntry = {
        id: nextId(),
        // History persists to localStorage-backed MMKV — cap per-entry size
        // (the live clipboard write elsewhere still uses the full payload).
        text: truncateForHistory(text),
        createdAt: Date.now(),
        ...source,
    };
    writeEntries(appendClipboardEntry(getClipboardHistory(), entry, CLIPBOARD_HISTORY_CAP));
    return entry;
}

/** Persist an in-place edit of one entry's text (history-row editor). */
export function updateClipboardHistoryText(id: string, text: string): void {
    const next = updateClipboardEntryText(getClipboardHistory(), id, text);
    if (next !== getClipboardHistory()) writeEntries(next);
}

export function deleteClipboardHistoryEntry(id: string): void {
    const next = removeClipboardEntry(getClipboardHistory(), id);
    if (next !== getClipboardHistory()) writeEntries(next);
}

export function clearClipboardHistory(): void {
    if (getClipboardHistory().length === 0) return;
    writeEntries([]);
}

export function useClipboardHistory(): ClipboardHistoryEntry[] {
    return React.useSyncExternalStore(subscribe, getClipboardHistory, getClipboardHistory);
}
