/**
 * B-766 B-1 — which view a lead session opens in, remembered per session on
 * this device (localStorage best-effort; private mode / quota → in-memory).
 * Default (D3): 「只看我和负责人」 — only an explicit 「全部消息」 is stored.
 */
import { useSyncExternalStore } from 'react';
import type { LeadViewMode } from './leadView';

export const LEAD_VIEW_STORAGE_KEY = 'vh:lead-view:v1';
/** Lead sessions churn; keep only the most recent choices. */
export const LEAD_VIEW_LIMIT = 200;
export const DEFAULT_LEAD_VIEW: LeadViewMode = 'owner';

export type LeadViewPrefs = Record<string, LeadViewMode>;

export function parseLeadViewPrefs(raw: string | null): LeadViewPrefs {
    if (!raw) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out: LeadViewPrefs = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (v === 'all' || v === 'owner') out[k] = v;
        return out;
    } catch {
        return {};
    }
}

export function leadViewFor(prefs: LeadViewPrefs, sessionId: string): LeadViewMode {
    return Object.prototype.hasOwnProperty.call(prefs, sessionId) ? prefs[sessionId] : DEFAULT_LEAD_VIEW;
}

/** Set one session's view; re-inserted last so trimming drops the oldest choices. */
export function withLeadView(prefs: LeadViewPrefs, sessionId: string, mode: LeadViewMode): LeadViewPrefs {
    const next: LeadViewPrefs = {};
    for (const [k, v] of Object.entries(prefs)) if (k !== sessionId) next[k] = v;
    next[sessionId] = mode;
    const keys = Object.keys(next);
    if (keys.length <= LEAD_VIEW_LIMIT) return next;
    const trimmed: LeadViewPrefs = {};
    for (const k of keys.slice(keys.length - LEAD_VIEW_LIMIT)) trimmed[k] = next[k];
    return trimmed;
}

let memory: LeadViewPrefs | null = null;
const listeners = new Set<() => void>();

function load(): LeadViewPrefs {
    if (memory) return memory;
    let raw: string | null = null;
    try {
        raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(LEAD_VIEW_STORAGE_KEY);
    } catch {
        raw = null;
    }
    memory = parseLeadViewPrefs(raw);
    return memory;
}

export function setLeadView(sessionId: string, mode: LeadViewMode): void {
    const cur = load();
    if (leadViewFor(cur, sessionId) === mode && Object.prototype.hasOwnProperty.call(cur, sessionId)) return;
    memory = withLeadView(cur, sessionId, mode);
    try {
        localStorage.setItem(LEAD_VIEW_STORAGE_KEY, JSON.stringify(memory));
    } catch {
        /* keep the in-memory state */
    }
    for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useLeadView(sessionId: string): LeadViewMode {
    const prefs = useSyncExternalStore(subscribe, load, load);
    return leadViewFor(prefs, sessionId);
}

/** test-only: forget the cached state */
export function resetLeadViewForTest(): void {
    memory = null;
}
