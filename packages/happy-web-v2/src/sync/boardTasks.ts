/**
 * Board-task registry (Task Board V2): the boss's high-level task list,
 * server-backed in the account KV store (key `vh.board-tasks.v1`) with an
 * MMKV blob as the instant offline cache. Trusted-v1 accounts retain the
 * legacy base64 carrier; E2EE accounts transparently wrap the exact bytes in
 * a context-bound stored envelope before they leave the browser. Server-side
 * task-title analysis is therefore unavailable for E2EE accounts by design.
 *
 * Mutations update local state + cache immediately (optimistic) and push to
 * KV in the background. The blob is version-checked; on a conflict the two
 * lists are merged per-task by `updatedAt` — see boardTaskOps.ts for the
 * full truth model (tombstoned deletes, unioned sessionIds).
 *
 * This is the codebase's one KV-list pattern (cache fingerprint, debounced
 * push, merge-on-409) — inherited from the retired KV terminal registry.
 * Unlike terminals (machine-owned, daemon-pushed), tasks have no machine to
 * own them, so the client-owned KV model is the right one here.
 */
import { create } from 'zustand';
import { getCurrentAuth } from '@/auth/AuthContext';
import { MMKV } from '@/storage/mmkv-web';
import { kvGet, kvSet } from '@/sync/apiKv';
import { accountFingerprint } from '@/sync/accountFingerprint';
import { mergeBoardTasks, orderKeyBetween, type BoardTask } from '@/sync/boardTaskOps';

export type { BoardTask } from '@/sync/boardTaskOps';

const mmkv = new MMKV();
const CACHE_KEY = 'board-tasks-cache-v1';
const KV_KEY = 'vh.board-tasks.v1';

interface CacheBlob {
  /** fingerprint of the account (auth token) that wrote this cache */
  account?: string | null;
  tasks: BoardTask[];
}

let cachedAccount: string | null | undefined;

function load(): BoardTask[] {
  try {
    const raw = mmkv.getString(CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CacheBlob;
    cachedAccount = parsed.account ?? null;
    return Array.isArray(parsed.tasks) ? parsed.tasks : [];
  } catch {
    return [];
  }
}

function persistLocal(list: BoardTask[]) {
  try {
    const auth = getCurrentAuth();
    const account = auth?.credentials
      ? accountFingerprint(auth.credentials.token)
      : (cachedAccount ?? null);
    cachedAccount = account;
    mmkv.set(CACHE_KEY, JSON.stringify({ account, tasks: list } satisfies CacheBlob));
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

function parseKvTasks(valueB64: string): BoardTask[] {
  const parsed = JSON.parse(fromB64(valueB64)) as { tasks?: BoardTask[] };
  return Array.isArray(parsed.tasks) ? parsed.tasks : [];
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
 *  (another device wrote first) merge their list with ours per-task and push
 *  the merged view — a blind re-push would clobber the other device. */
function scheduleKvPush() {
  const auth = getCurrentAuth();
  if (!auth?.credentials) return; // not logged in → local cache only
  const creds = auth.credentials;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    const snapshot = () => useBoardTasks.getState().tasks;
    try {
      const value = toB64(JSON.stringify({ tasks: snapshot() }));
      kvVersion = await kvSet(creds, KV_KEY, value, kvVersion ?? -1);
    } catch (e: any) {
      try {
        const fresh = await kvGet(creds, KV_KEY);
        const remote = fresh ? parseKvTasks(fresh.value) : [];
        const merged = mergeBoardTasks(snapshot(), remote);
        persistLocal(merged);
        useBoardTasks.setState({ tasks: merged });
        kvVersion = fresh?.version ?? -1;
        const value = toB64(JSON.stringify({ tasks: merged }));
        kvVersion = await kvSet(creds, KV_KEY, value, kvVersion);
      } catch {
        console.warn('[boardTasks] KV push failed', e?.message);
      }
    }
  }, 400);
}

interface BoardTasksState {
  tasks: BoardTask[];
  initialized: boolean;
  /** Load the server-backed list (call once per board mount). Merges into local cache. */
  initialize(): Promise<void>;
  create(title: string, description?: string): BoardTask;
  setStatus(id: string, status: 'open' | 'done'): void;
  /** Edit title/description — a record mutation (bumps updatedAt). */
  update(id: string, changes: { title?: string; description?: string }): void;
  /** Tombstone delete — propagates across devices, see boardTaskOps.ts. */
  remove(id: string): void;
  /** Record a dispatched session under a task (manual mapping — wins over
   *  the LLM's metadata.board.taskId fallback). */
  attachSession(id: string, sessionId: string): void;
  /** Apply fractional order keys (from planOrderWrites). Bumps orderAt only —
   *  NOT updatedAt — so a reorder can never beat a concurrent content edit
   *  in the per-task merge. */
  applyOrders(writes: Array<{ id: string; order: string }>): void;
}

export const useBoardTasks = create<BoardTasksState>((set, get) => ({
  tasks: load(),
  initialized: false,
  initialize: async () => {
    const auth = getCurrentAuth();
    if (!auth?.credentials) return;
    // Same defense-in-depth as the terminal registry: a cache that outlived a
    // logout must not merge a stranger's tasks into THIS account's KV list.
    const fp = accountFingerprint(auth.credentials.token);
    if (cachedAccount !== fp) {
      cachedAccount = fp;
      if (get().tasks.length > 0) {
        set({ tasks: [] });
        persistLocal([]);
      }
    }
    try {
      const item = await kvGet(auth.credentials, KV_KEY);
      if (item) {
        kvVersion = item.version;
        const remote = parseKvTasks(item.value);
        const merged = mergeBoardTasks(get().tasks, remote);
        persistLocal(merged);
        set({ tasks: merged, initialized: true });
        if (JSON.stringify(merged) !== JSON.stringify(remote)) scheduleKvPush();
      } else {
        kvVersion = -1;
        set({ initialized: true });
        if (get().tasks.length) scheduleKvPush();
      }
    } catch (e: any) {
      console.warn('[boardTasks] KV load failed; using local cache', e?.message);
      set({ initialized: true });
    }
  },
  create: (title, description) => {
    const now = Date.now();
    // New task goes to the TOP of the board: order key before the smallest
    // existing one (legacy unkeyed tasks sort after keyed ones anyway).
    let minOrder: string | null = null;
    for (const t of get().tasks) {
      if (t.status === 'deleted' || t.order == null) continue;
      if (minOrder === null || t.order < minOrder) minOrder = t.order;
    }
    const task: BoardTask = {
      id: newId(),
      title: title.trim(),
      description: description?.trim() || undefined,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      order: orderKeyBetween(null, minOrder),
      orderAt: now,
    };
    const next = [task, ...get().tasks];
    persistLocal(next);
    set({ tasks: next });
    scheduleKvPush();
    return task;
  },
  setStatus: (id, status) => {
    const now = Date.now();
    const next = get().tasks.map((t) =>
      t.id === id && t.status !== 'deleted' && t.status !== status
        ? { ...t, status, updatedAt: now }
        : t,
    );
    persistLocal(next);
    set({ tasks: next });
    scheduleKvPush();
  },
  update: (id, changes) => {
    const now = Date.now();
    const next = get().tasks.map((t) => {
      if (t.id !== id || t.status === 'deleted') return t;
      const title = changes.title !== undefined ? changes.title.trim() : t.title;
      const description =
        changes.description !== undefined ? changes.description.trim() || undefined : t.description;
      if (title === t.title && description === t.description) return t;
      return { ...t, title: title || t.title, description, updatedAt: now };
    });
    persistLocal(next);
    set({ tasks: next });
    scheduleKvPush();
  },
  remove: (id) => {
    const now = Date.now();
    const next = get().tasks.map((t) =>
      t.id === id && t.status !== 'deleted'
        ? { ...t, status: 'deleted' as const, updatedAt: now }
        : t,
    );
    persistLocal(next);
    set({ tasks: next });
    scheduleKvPush();
  },
  attachSession: (id, sessionId) => {
    const now = Date.now();
    const next = get().tasks.map((t) => {
      if (t.id !== id || t.status === 'deleted') return t;
      if (t.sessionIds?.includes(sessionId)) return t;
      return { ...t, sessionIds: [...(t.sessionIds ?? []), sessionId], updatedAt: now };
    });
    persistLocal(next);
    set({ tasks: next });
    scheduleKvPush();
  },
  applyOrders: (writes) => {
    if (writes.length === 0) return;
    const now = Date.now();
    const byId = new Map(writes.map((w) => [w.id, w.order]));
    const next = get().tasks.map((t) => {
      const order = byId.get(t.id);
      if (order === undefined || t.status === 'deleted' || t.order === order) return t;
      return { ...t, order, orderAt: now };
    });
    persistLocal(next);
    set({ tasks: next });
    scheduleKvPush();
  },
}));
