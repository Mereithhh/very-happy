/**
 * Registry of web terminal sessions, now **server-backed** so terminals are
 * unified with chat sessions: persisted in the account KV store (key
 * `vh.terminal-sessions`) and therefore synced across devices, with localStorage
 * as an instant offline cache. A terminal session is a tmux `vh-<id>` session on
 * a machine; we own the id client-side so reopening reattaches to the live tmux
 * session (state survives reloads/navigation/other devices).
 *
 * Mutations update local state + cache immediately (optimistic) and push to KV in
 * the background (version-aware, last-write-wins on the small list blob).
 */
import { create } from 'zustand';
import { getCurrentAuth } from '@/auth/AuthContext';
import { kvGet, kvSet } from '@/sync/apiKv';

export interface TerminalSession {
  id: string; // tmux session = vh-<id>, also the relay terminalId
  machineId: string;
  machineName: string;
  title: string;
  manual?: boolean; // user renamed it → never auto-title again
  createdAt: number;
}

const KEY = 'vh.terminals.v1';
const KV_KEY = 'vh.terminal-sessions';

function load(): TerminalSession[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as TerminalSession[]) : [];
  } catch {
    return [];
  }
}

function persistLocal(list: TerminalSession[]) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* best-effort */
  }
}

function toB64(json: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(json)));
}
function fromB64(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function newId(): string {
  try {
    const c = (globalThis as any).crypto;
    if (c?.randomUUID) return (c.randomUUID() as string).replace(/-/g, '').slice(0, 12);
  } catch {
    /* fall through */
  }
  return Math.random().toString(36).slice(2, 14);
}

let kvVersion: number | undefined;
let pushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleKvPush(list: TerminalSession[]) {
  const auth = getCurrentAuth();
  if (!auth?.credentials) return; // not logged in → local cache only
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    try {
      const value = toB64(JSON.stringify({ terminals: list }));
      kvVersion = await kvSet(auth.credentials, KV_KEY, value, kvVersion ?? -1);
    } catch (e: any) {
      // version-mismatch (another device wrote) → refetch version and retry once
      try {
        const fresh = await kvGet(auth!.credentials, KV_KEY);
        kvVersion = fresh?.version ?? -1;
        const value = toB64(JSON.stringify({ terminals: list }));
        kvVersion = await kvSet(auth!.credentials, KV_KEY, value, kvVersion);
      } catch {
        console.warn('[terminals] KV push failed', e?.message);
      }
    }
  }, 400);
}

interface TerminalSessionsState {
  terminals: TerminalSession[];
  initialized: boolean;
  /** Load the server-backed list (call once after auth). Merges into local cache. */
  initialize(): Promise<void>;
  create(machineId: string, machineName: string, title?: string): TerminalSession;
  rename(id: string, title: string): void;
  autoTitle(id: string, title: string): void;
  remove(id: string): void;
}

export const useTerminalSessions = create<TerminalSessionsState>((set, get) => ({
  terminals: load(),
  initialized: false,
  initialize: async () => {
    const auth = getCurrentAuth();
    if (!auth?.credentials) return;
    try {
      const item = await kvGet(auth.credentials, KV_KEY);
      if (item) {
        kvVersion = item.version;
        const parsed = JSON.parse(fromB64(item.value)) as { terminals?: TerminalSession[] };
        const list = Array.isArray(parsed.terminals) ? parsed.terminals : [];
        persistLocal(list);
        set({ terminals: list, initialized: true });
      } else {
        // no server record yet → seed it from whatever is local
        kvVersion = -1;
        set({ initialized: true });
        if (get().terminals.length) scheduleKvPush(get().terminals);
      }
    } catch (e: any) {
      console.warn('[terminals] KV load failed; using local cache', e?.message);
      set({ initialized: true });
    }
  },
  create: (machineId, machineName, title) => {
    const t: TerminalSession = {
      id: newId(),
      machineId,
      machineName,
      title: title?.trim() || machineName || 'Terminal',
      createdAt: Date.now(),
    };
    const next = [t, ...get().terminals];
    persistLocal(next);
    set({ terminals: next });
    scheduleKvPush(next);
    return t;
  },
  rename: (id, title) => {
    const next = get().terminals.map((t) =>
      t.id === id ? { ...t, title: title.trim() || t.title, manual: true } : t,
    );
    persistLocal(next);
    set({ terminals: next });
    scheduleKvPush(next);
  },
  autoTitle: (id, title) => {
    const clean = title.trim().slice(0, 48);
    if (!clean) return;
    const next = get().terminals.map((t) =>
      t.id === id && !t.manual && t.title === t.machineName ? { ...t, title: clean } : t,
    );
    persistLocal(next);
    set({ terminals: next });
    scheduleKvPush(next);
  },
  remove: (id) => {
    const next = get().terminals.filter((t) => t.id !== id);
    persistLocal(next);
    set({ terminals: next });
    scheduleKvPush(next);
  },
}));
