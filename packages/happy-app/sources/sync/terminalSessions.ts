/**
 * Client-side registry of web terminal sessions (web-only, device-local).
 *
 * A terminal session is a tmux `vh-<id>` session on a machine. We own the id
 * client-side so reopening reattaches to the live tmux session (state survives
 * reloads/navigation). Persisted to localStorage so the sidebar "Terminals"
 * group survives refreshes. Not synced across devices — intentionally light.
 */
import { create } from 'zustand';

export interface TerminalSession {
    id: string;            // tmux session = vh-<id>, also the relay terminalId
    machineId: string;
    machineName: string;
    title: string;
    manual?: boolean;      // user renamed it → never auto-title again
    createdAt: number;
}

const KEY = 'vh.terminals.v1';

function load(): TerminalSession[] {
    try {
        if (typeof localStorage === 'undefined') return [];
        const raw = localStorage.getItem(KEY);
        return raw ? (JSON.parse(raw) as TerminalSession[]) : [];
    } catch {
        return [];
    }
}

function persist(list: TerminalSession[]) {
    try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(list));
    } catch {
        // best-effort
    }
}

function newId(): string {
    try {
        const c = (globalThis as any).crypto;
        if (c?.randomUUID) return (c.randomUUID() as string).replace(/-/g, '').slice(0, 12);
    } catch { /* fall through */ }
    return Math.random().toString(36).slice(2, 14);
}

interface TerminalSessionsState {
    terminals: TerminalSession[];
    create(machineId: string, machineName: string, title?: string): TerminalSession;
    rename(id: string, title: string): void;
    /** Set a title derived automatically (e.g. first command). Applies only
     *  while the title is still the machine-name default and not user-renamed,
     *  so it replaces the default once and never fights a manual rename. */
    autoTitle(id: string, title: string): void;
    remove(id: string): void;
}

export const useTerminalSessions = create<TerminalSessionsState>((set, get) => ({
    terminals: load(),
    create: (machineId, machineName, title) => {
        const t: TerminalSession = {
            id: newId(),
            machineId,
            machineName,
            title: title?.trim() || machineName || 'Terminal',
            createdAt: Date.now(),
        };
        const next = [t, ...get().terminals];
        persist(next);
        set({ terminals: next });
        return t;
    },
    rename: (id, title) => {
        const next = get().terminals.map((t) => (t.id === id ? { ...t, title: title.trim() || t.title, manual: true } : t));
        persist(next);
        set({ terminals: next });
    },
    autoTitle: (id, title) => {
        const clean = title.trim().slice(0, 48);
        if (!clean) return;
        const next = get().terminals.map((t) =>
            (t.id === id && !t.manual && t.title === t.machineName) ? { ...t, title: clean } : t);
        persist(next);
        set({ terminals: next });
    },
    remove: (id) => {
        const next = get().terminals.filter((t) => t.id !== id);
        persist(next);
        set({ terminals: next });
    },
}));
