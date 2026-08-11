/**
 * Registry of web terminal sessions, now **server-backed** so terminals are
 * unified with chat sessions: persisted in the account KV store (key
 * `vh.terminal-sessions`) and therefore synced across devices, with localStorage
 * as an instant offline cache. A terminal session is a tmux `vh-<id>` session on
 * a machine; we own the id client-side so reopening reattaches to the live tmux
 * session (state survives reloads/navigation/other devices).
 *
 * Mutations update local state + cache immediately (optimistic) and push to KV in
 * the background. The KV blob is version-checked; on a conflict (another device
 * wrote) the two lists are merged per-terminal by `updatedAt` — NOT blob-level
 * last-write-wins — see terminalListOps.ts for the full truth model.
 *
 * Titles: the machine's tmux `@vh_title` is the cross-device truth. `rename()`
 * writes it there (and marks the record `pendingTitle` until the machine acks);
 * `reconcile()` backfills machine titles into local records so other devices
 * pick a rename up within one sidebar poll (~10s).
 */
import { create } from 'zustand';
import { getCurrentAuth } from '@/auth/AuthContext';
import { kvGet, kvSet } from '@/sync/apiKv';
import { machineSetTerminalTitle } from '@/sync/ops';
import {
  mergeTerminalLists,
  reconcileWithMachine,
  type LiveTerminal,
  type TerminalSession,
} from '@/sync/terminalListOps';

export type { TerminalSession } from '@/sync/terminalListOps';

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

function parseKvList(valueB64: string): TerminalSession[] {
  const parsed = JSON.parse(fromB64(valueB64)) as { terminals?: TerminalSession[] };
  return Array.isArray(parsed.terminals) ? parsed.terminals : [];
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

/** Push the CURRENT store list to KV (debounced). On a version conflict
 *  (another device wrote first) merge their list with ours per-terminal and
 *  push the merged view — blind re-push would clobber the other device. */
function scheduleKvPush() {
  const auth = getCurrentAuth();
  if (!auth?.credentials) return; // not logged in → local cache only
  const creds = auth.credentials;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    const snapshot = () => useTerminalSessions.getState().terminals;
    try {
      const value = toB64(JSON.stringify({ terminals: snapshot() }));
      kvVersion = await kvSet(creds, KV_KEY, value, kvVersion ?? -1);
    } catch (e: any) {
      // version-mismatch (another device wrote) → merge and retry once
      try {
        const fresh = await kvGet(creds, KV_KEY);
        const remote = fresh ? parseKvList(fresh.value) : [];
        const merged = mergeTerminalLists(snapshot(), remote);
        persistLocal(merged);
        useTerminalSessions.setState({ terminals: merged });
        kvVersion = fresh?.version ?? -1;
        const value = toB64(JSON.stringify({ terminals: merged }));
        kvVersion = await kvSet(creds, KV_KEY, value, kvVersion);
      } catch {
        console.warn('[terminals] KV push failed', e?.message);
      }
    }
  }, 400);
}

/** After the machine acked a rename, drop the pending flag (only if the title
 *  is still the one we pushed — a newer rename keeps its own pending state). */
function clearPendingTitle(id: string, title: string) {
  const cur = useTerminalSessions.getState().terminals;
  const next = cur.map((t) =>
    t.id === id && t.pendingTitle && t.title === title
      ? { ...t, pendingTitle: undefined, updatedAt: Date.now() }
      : t,
  );
  if (next.some((t, i) => t !== cur[i])) {
    persistLocal(next);
    useTerminalSessions.setState({ terminals: next });
    scheduleKvPush();
  }
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
  /** Reconcile the list against a machine's REAL live tmux `vh-*` sessions:
   *  adopt orphans, drop dead records, and sync titles (machine `@vh_title` is
   *  the truth; unacked local renames are pushed out instead — see
   *  terminalListOps.ts). `live=null` means the query failed → no-op. */
  reconcile(machineId: string, machineName: string, live: LiveTerminal[] | null): void;
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
        const remote = parseKvList(item.value);
        // Merge rather than replace: the local cache may hold records/renames
        // made while offline that the server copy predates.
        const merged = mergeTerminalLists(get().terminals, remote);
        persistLocal(merged);
        set({ terminals: merged, initialized: true });
        if (JSON.stringify(merged) !== JSON.stringify(remote)) scheduleKvPush();
      } else {
        // no server record yet → seed it from whatever is local
        kvVersion = -1;
        set({ initialized: true });
        if (get().terminals.length) scheduleKvPush();
      }
    } catch (e: any) {
      console.warn('[terminals] KV load failed; using local cache', e?.message);
      set({ initialized: true });
    }
  },
  create: (machineId, machineName, title) => {
    const now = Date.now();
    const t: TerminalSession = {
      id: newId(),
      machineId,
      machineName,
      title: title?.trim() || machineName || 'Terminal',
      createdAt: now,
      updatedAt: now,
    };
    const next = [t, ...get().terminals];
    persistLocal(next);
    set({ terminals: next });
    scheduleKvPush();
    return t;
  },
  rename: (id, title) => {
    const clean = title.trim();
    if (!clean) return;
    const now = Date.now();
    let machineId: string | undefined;
    const next = get().terminals.map((t) => {
      if (t.id !== id) return t;
      machineId = t.machineId;
      return { ...t, title: clean, manual: true, updatedAt: now, pendingTitle: true };
    });
    persistLocal(next);
    set({ terminals: next });
    scheduleKvPush();
    // Write the title to the machine (tmux @vh_title) — the cross-device truth
    // source; other devices backfill it on their next reconcile poll. If the
    // machine is unreachable, `pendingTitle` stays set and reconcile() retries
    // the push when the machine is back.
    if (machineId) {
      void machineSetTerminalTitle(machineId, id, clean).then((ok) => {
        if (ok) clearPendingTitle(id, clean);
      });
    }
  },
  autoTitle: (id, title) => {
    const clean = title.trim().slice(0, 48);
    if (!clean) return;
    const now = Date.now();
    const next = get().terminals.map((t) =>
      t.id === id && !t.manual && t.title === t.machineName
        ? { ...t, title: clean, updatedAt: now }
        : t,
    );
    persistLocal(next);
    set({ terminals: next });
    scheduleKvPush();
  },
  remove: (id) => {
    const next = get().terminals.filter((t) => t.id !== id);
    persistLocal(next);
    set({ terminals: next });
    scheduleKvPush();
  },
  reconcile: (machineId, machineName, live) => {
    if (live == null) return; // query failed → don't touch records
    const { next, pushTitles, changed } = reconcileWithMachine(
      get().terminals,
      machineId,
      machineName,
      live,
      Date.now(),
    );
    // Local renames the machine never received (offline rename / pre-fix
    // records) → push them out; the pending flag clears once the machine acks
    // (immediately below, or via title match on the next poll).
    for (const p of pushTitles) {
      void machineSetTerminalTitle(p.machineId, p.id, p.title).then((ok) => {
        if (ok) clearPendingTitle(p.id, p.title);
      });
    }
    // Commit only on a real change, so a steady state doesn't churn the KV version.
    if (!changed) return;
    persistLocal(next);
    set({ terminals: next });
    scheduleKvPush();
  },
}));
