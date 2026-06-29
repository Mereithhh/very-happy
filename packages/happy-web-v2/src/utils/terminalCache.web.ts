/**
 * Module-level keep-alive cache for web terminals (web only).
 *
 * Switching tabs unmounts the terminal screen. Without this cache, the screen's
 * effect cleanup would `terminal-close` + `term.dispose()` and the next mount
 * would reconnect from scratch (slow, and the old scrollback/state is gone).
 *
 * Instead we stash the live xterm instance + its socket listeners here, keyed by
 * `${machineId}:${tid}`. The listeners (terminal-output/-exit, onData/onKey,
 * OSC52, selection) hang off apiSocket and the term object — NOT off the DOM —
 * so while the tab is hidden, `terminal-output` keeps writing into the cached
 * term. Switching back just re-parents `term.element` into the new host: the
 * screen shows the latest state instantly, the tmux session never reattaches.
 *
 * Lifetime: a terminal is only truly destroyed when removed from the list. There
 * is no UI wiring for that yet (machineKillTerminal exists in ops.ts but isn't
 * called from the sessions menu), so to avoid leaking pty connections forever we
 * cap the cache (LRU): opening a 9th distinct terminal disposes the
 * least-recently-shown one (term.dispose + terminal-close + drop listeners).
 * disposeTerminalCache() is exported so a future "kill terminal" path can evict
 * a specific entry deterministically.
 */
import type { Terminal } from '@xterm/xterm';
import { apiSocket } from '@/sync/apiSocket';

export interface TerminalCacheEntry {
    term: Terminal;
    /** The daemon-assigned terminal id (resolved after machineOpenTerminal). */
    terminalId: string | null;
    /** Dispose hooks for the socket/term listeners that survive while hidden. */
    cleanups: Array<() => void>;
    /** auto-title state, kept here so reused terminals don't re-title. */
    titled: boolean;
    /** order counter for LRU; bumped on every show/create. */
    lastUsed: number;
}

const cache = new Map<string, TerminalCacheEntry>();
let seq = 0;
const MAX_ENTRIES = 8;

export function cacheKey(machineId: string, tid: string | undefined): string {
    return `${machineId}:${tid ?? ''}`;
}

export function getTerminalEntry(key: string): TerminalCacheEntry | undefined {
    const e = cache.get(key);
    if (e) e.lastUsed = ++seq;
    return e;
}

/** Insert a new entry and evict the least-recently-used over the cap. */
export function setTerminalEntry(key: string, entry: Omit<TerminalCacheEntry, 'lastUsed'>): TerminalCacheEntry {
    const full: TerminalCacheEntry = { ...entry, lastUsed: ++seq };
    cache.set(key, full);
    evictOverCap();
    return full;
}

function destroyEntry(key: string, entry: TerminalCacheEntry) {
    cache.delete(key);
    try { entry.cleanups.forEach((c) => c()); } catch { /* best-effort */ }
    if (entry.terminalId) {
        // We don't know machineId from the entry; recover it from the key
        // (machineId can't contain ':' — it's a uuid).
        const machineId = key.slice(0, key.lastIndexOf(':'));
        try { apiSocket.send('terminal-close', { machineId, terminalId: entry.terminalId }); } catch { /* socket down */ }
    }
    try { entry.term.dispose(); } catch { /* already disposed */ }
}

function evictOverCap() {
    while (cache.size > MAX_ENTRIES) {
        let oldestKey: string | null = null;
        let oldest = Infinity;
        for (const [k, e] of cache) {
            if (e.lastUsed < oldest) { oldest = e.lastUsed; oldestKey = k; }
        }
        if (!oldestKey) break;
        const e = cache.get(oldestKey)!;
        destroyEntry(oldestKey, e);
    }
}

/** Deterministically tear down a specific cached terminal (e.g. on kill). */
export function disposeTerminalCache(machineId: string, tid: string | undefined): void {
    const key = cacheKey(machineId, tid);
    const e = cache.get(key);
    if (e) destroyEntry(key, e);
}
