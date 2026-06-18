import { create } from 'zustand';

/**
 * Lightweight, in-memory multi-tab store for the desktop files sidebar.
 *
 * Each open file becomes a tab keyed by its absolute/normalized path. Opening a
 * file from the "All Files" sidebar tab either activates an already-open tab or
 * appends a new one and makes it active. The tab bar (rendered above the
 * FileViewPanel) switches / closes tabs.
 *
 * Scoped per session so switching sessions doesn't leak open files. State is
 * memory-only on purpose — open files are ephemeral working context, not a
 * preference worth persisting across reloads.
 */

export interface FileTab {
    /** Normalized file path — also the tab identity. */
    path: string;
    /** Basename used as the tab label. */
    name: string;
}

interface SessionFileTabs {
    tabs: FileTab[];
    activePath: string | null;
}

interface FileTabsStore {
    /** Keyed by sessionId. */
    bySession: Record<string, SessionFileTabs>;
    /** Open (or focus) a file tab for a session; returns the active path. */
    openTab: (sessionId: string, path: string) => void;
    /** Close a tab; if it was active, activate a neighbouring tab. */
    closeTab: (sessionId: string, path: string) => void;
    /** Make an already-open tab active. */
    activateTab: (sessionId: string, path: string) => void;
    /** Drop all tabs for a session (e.g. leaving the session). */
    clearSession: (sessionId: string) => void;
}

function basename(path: string): string {
    const parts = path.split(/[/\\]/).filter(Boolean);
    return parts[parts.length - 1] ?? path;
}

const EMPTY: SessionFileTabs = { tabs: [], activePath: null };

export const useFileTabs = create<FileTabsStore>((set) => ({
    bySession: {},
    openTab: (sessionId, path) => set((state) => {
        const current = state.bySession[sessionId] ?? EMPTY;
        const exists = current.tabs.some((t) => t.path === path);
        const tabs = exists
            ? current.tabs
            : [...current.tabs, { path, name: basename(path) }];
        return {
            bySession: {
                ...state.bySession,
                [sessionId]: { tabs, activePath: path },
            },
        };
    }),
    closeTab: (sessionId, path) => set((state) => {
        const current = state.bySession[sessionId];
        if (!current) return state;
        const idx = current.tabs.findIndex((t) => t.path === path);
        if (idx === -1) return state;
        const tabs = current.tabs.filter((t) => t.path !== path);
        let activePath = current.activePath;
        if (activePath === path) {
            // Activate the previous tab, or the next one if we closed the first.
            const neighbour = tabs[idx - 1] ?? tabs[idx] ?? null;
            activePath = neighbour ? neighbour.path : null;
        }
        return {
            bySession: {
                ...state.bySession,
                [sessionId]: { tabs, activePath },
            },
        };
    }),
    activateTab: (sessionId, path) => set((state) => {
        const current = state.bySession[sessionId];
        if (!current || current.activePath === path) return state;
        if (!current.tabs.some((t) => t.path === path)) return state;
        return {
            bySession: {
                ...state.bySession,
                [sessionId]: { ...current, activePath: path },
            },
        };
    }),
    clearSession: (sessionId) => set((state) => {
        if (!state.bySession[sessionId]) return state;
        const next = { ...state.bySession };
        delete next[sessionId];
        return { bySession: next };
    }),
}));

/** Selector hook: tabs + active path for a session. */
export function useSessionFileTabs(sessionId: string): SessionFileTabs {
    return useFileTabs((s) => s.bySession[sessionId] ?? EMPTY);
}
