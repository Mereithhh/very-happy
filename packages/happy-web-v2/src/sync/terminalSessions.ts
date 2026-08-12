/**
 * Registry of web terminal sessions — the ONE list every consumer renders
 * (sidebar, board, palette, picker, terminal screen). Since the daemon-push
 * rework it is composed from two truth models (see terminalPushOps.ts):
 *
 *   PUSHED machines (new daemons): the machine's daemonState.webTerminals is
 *   the list. Fed by terminalSync via `applyPush()`; mutations go straight to
 *   the machine over RPC and render optimistically through a small overlay
 *   until the confirming push lands. No client-side persistence, no KV
 *   writes, no tombstones — deletion propagates by absence from the push,
 *   and OFFLINE machines still display because the server persists their
 *   last daemonState.
 *
 *   LEGACY machines (old daemons, feature-detected per machine): the original
 *   client-owned model — records persisted in the account KV store
 *   (`vh.terminal-sessions`) with an MMKV offline cache, reconciled against
 *   the machine's live tmux by the 10s poll, per-terminal merge on KV
 *   conflicts, deletion tombstones. This whole path (and terminalListOps.ts)
 *   retires once the daemon fleet is upgraded.
 *
 * KV records belonging to pushed machines are deliberately left untouched:
 * old web clients still poll those machines and maintain their records; this
 * client simply stops rendering or mutating them (composeTerminalList drops
 * them), so the mixed period is write-conflict-free.
 *
 * Titles: the machine's tmux `@vh_title` is the cross-device truth for BOTH
 * models. Pushed machines confirm a rename via the next push; legacy machines
 * keep the `pendingTitle` ack/retry mechanics.
 */
import { create } from 'zustand';
import { getCurrentAuth } from '@/auth/AuthContext';
import { MMKV } from '@/storage/mmkv-web';
import { kvGet, kvSet } from '@/sync/apiKv';
import { machineSetTerminalTitle, type MachineTerminal } from '@/sync/ops';
import {
  mergeTerminalLists,
  reconcileWithMachine,
  type LiveTerminal,
  type TerminalSession,
} from '@/sync/terminalListOps';
import {
  composeTerminalList,
  pruneOverlay,
  EMPTY_OVERLAY,
  CREATE_OVERLAY_TTL_MS,
  RENAME_OVERLAY_TTL_MS,
  REMOVE_OVERLAY_TTL_MS,
  type MachinePush,
  type PushOverlay,
} from '@/sync/terminalPushOps';

export type { TerminalSession } from '@/sync/terminalListOps';

// Local offline cache. Lives in the default MMKV namespace (localStorage keys
// prefixed `mmkv:default:`) so logout's clearPersistence() → mmkv.clearAll()
// wipes it with the rest of the account-scoped state. The pre-fix bare
// `vh.terminals.v1` key survived logout, so the NEXT account's initialize()
// merged the previous account's terminal records into its own KV list — a
// cross-account leak. The legacy key is deleted, never migrated: there is no
// way to tell which account wrote it.
const mmkv = new MMKV();
const CACHE_KEY = 'terminal-sessions-cache-v2';
const LEGACY_KEY = 'vh.terminals.v1';
const KV_KEY = 'vh.terminal-sessions';

interface CacheBlob {
  /** Fingerprint of the account (auth token) that wrote this cache. */
  account?: string | null;
  terminals: TerminalSession[];
}

/** Non-cryptographic fingerprint (FNV-1a) of the auth token. Only used to ask
 *  "did the same account write this cache?" — never stored as, or derived
 *  into, anything secret. */
function accountFingerprint(token: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Which account the loaded/persisted cache belongs to (undefined = no blob). */
let cachedAccount: string | null | undefined;

function load(): TerminalSession[] {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(LEGACY_KEY);
    const raw = mmkv.getString(CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CacheBlob;
    cachedAccount = parsed.account ?? null;
    return Array.isArray(parsed.terminals) ? parsed.terminals : [];
  } catch {
    return [];
  }
}

function persistLocal(list: TerminalSession[]) {
  try {
    const auth = getCurrentAuth();
    const account = auth?.credentials
      ? accountFingerprint(auth.credentials.token)
      : (cachedAccount ?? null);
    cachedAccount = account;
    const blob: CacheBlob = { account, terminals: list };
    mmkv.set(CACHE_KEY, JSON.stringify(blob));
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

/** Push the CURRENT legacy (KV-backed) list to KV (debounced). On a version
 *  conflict (another device wrote first) merge their list with ours
 *  per-terminal and push the merged view — blind re-push would clobber the
 *  other device. Only legacy records live here; pushed machines never write. */
function scheduleKvPush() {
  const auth = getCurrentAuth();
  if (!auth?.credentials) return; // not logged in → local cache only
  const creds = auth.credentials;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    const snapshot = () => useTerminalSessions.getState().kvList;
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
        useTerminalSessions.getState().commitKv(merged);
        kvVersion = fresh?.version ?? -1;
        const value = toB64(JSON.stringify({ terminals: merged }));
        kvVersion = await kvSet(creds, KV_KEY, value, kvVersion);
      } catch {
        console.warn('[terminals] KV push failed', e?.message);
      }
    }
  }, 400);
}

/** After the machine acked a legacy rename, drop the pending flag (only if the
 *  title is still the one we pushed — a newer rename keeps its own pending
 *  state). */
function clearPendingTitle(id: string, title: string) {
  const cur = useTerminalSessions.getState().kvList;
  const next = cur.map((t) =>
    t.id === id && t.pendingTitle && t.title === title
      ? { ...t, pendingTitle: undefined, updatedAt: Date.now() }
      : t,
  );
  if (next.some((t, i) => t !== cur[i])) {
    persistLocal(next);
    useTerminalSessions.getState().commitKv(next);
    scheduleKvPush();
  }
}

/** Timed overlay entries (optimistic create/rename/remove) need a sweep at
 *  their TTL even if no push arrives — otherwise an expired entry lingers
 *  until the next unrelated store event. */
function scheduleOverlaySweep(ttlMs: number) {
  setTimeout(() => useTerminalSessions.getState().sweepOverlay(), ttlMs + 100);
}

interface TerminalSessionsState {
  /** The composed list every consumer renders (pushed ∪ overlay ∪ legacy). */
  terminals: TerminalSession[];
  /** Legacy KV-backed records (old-daemon machines + their tombstones). */
  kvList: TerminalSession[];
  /** machineId → applied push (trusted daemonState.webTerminals snapshots). */
  pushes: Record<string, MachinePush>;
  /** Optimistic overlay for pushed-machine mutations. */
  overlay: PushOverlay;
  initialized: boolean;
  /** Load the server-backed legacy list (call once after auth). */
  initialize(): Promise<void>;
  create(machineId: string, machineName: string, title?: string): TerminalSession;
  rename(id: string, title: string): void;
  autoTitle(id: string, title: string): void;
  remove(id: string): void;
  /** LEGACY machines only: reconcile records against the machine's live tmux
   *  (adopt orphans, drop dead records, sync titles — terminalListOps.ts).
   *  No-op for pushed machines: the push already IS the machine's list. */
  reconcile(machineId: string, machineName: string, live: LiveTerminal[] | null): void;
  /** Apply one machine's trusted webTerminals snapshot (terminalSync). */
  applyPush(machineId: string, machineName: string, terminals: MachineTerminal[]): void;
  /** The machine lost push trust (daemon downgrade) → back to the legacy path. */
  clearPush(machineId: string): void;
  /** Is this machine currently fed by pushes? */
  isPushed(machineId: string): boolean;
  /** Drop expired overlay entries (timed sweep). */
  sweepOverlay(): void;
  /** Internal: replace the legacy list and recompose. */
  commitKv(kv: TerminalSession[]): void;
}

/** Recompose the rendered list from the three sources. */
function composed(kv: TerminalSession[], pushes: Record<string, MachinePush>, overlay: PushOverlay): TerminalSession[] {
  return composeTerminalList(kv, pushes, overlay, Date.now());
}

// Loaded once, synchronously, at store creation: seeds BOTH the legacy list
// and the composed view (no pushes/overlay exist yet, so they're identical).
const initialKv = load();

export const useTerminalSessions = create<TerminalSessionsState>((set, get) => ({
  terminals: initialKv,
  kvList: initialKv,
  pushes: {},
  overlay: EMPTY_OVERLAY,
  initialized: false,
  initialize: async () => {
    const auth = getCurrentAuth();
    if (!auth?.credentials) return;
    // Defense-in-depth against a cache that outlived a logout (crash before
    // clearPersistence, restored localStorage backup, …): the blob records
    // which account wrote it; a mismatch — or a blob with no fingerprint —
    // discards the local records instead of merging a stranger's terminals
    // into THIS account's KV list. The server copy is the durable truth, so
    // dropping the cache costs nothing beyond offline edits.
    const fp = accountFingerprint(auth.credentials.token);
    if (cachedAccount !== fp) {
      cachedAccount = fp;
      if (get().kvList.length > 0) {
        get().commitKv([]);
        persistLocal([]);
      }
    }
    try {
      const item = await kvGet(auth.credentials, KV_KEY);
      if (item) {
        kvVersion = item.version;
        const remote = parseKvList(item.value);
        // Merge rather than replace: the local cache may hold records/renames
        // made while offline that the server copy predates.
        const merged = mergeTerminalLists(get().kvList, remote);
        persistLocal(merged);
        get().commitKv(merged);
        set({ initialized: true });
        if (JSON.stringify(merged) !== JSON.stringify(remote)) scheduleKvPush();
      } else {
        // no server record yet → seed it from whatever is local
        kvVersion = -1;
        set({ initialized: true });
        if (get().kvList.length) scheduleKvPush();
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
    const { kvList, pushes, overlay } = get();
    if (pushes[machineId]) {
      // Pushed machine: the terminal becomes real when the terminal screen's
      // `open-terminal` creates the tmux session and the daemon pushes it.
      // Until then (or the TTL, if the open never happens) this overlay row
      // is the only place it exists — no KV write.
      const nextOverlay: PushOverlay = { ...overlay, created: [t, ...overlay.created] };
      set({ overlay: nextOverlay, terminals: composed(kvList, pushes, nextOverlay) });
      scheduleOverlaySweep(CREATE_OVERLAY_TTL_MS);
      return t;
    }
    const next = [t, ...kvList];
    persistLocal(next);
    get().commitKv(next);
    scheduleKvPush();
    return t;
  },
  rename: (id, title) => {
    const clean = title.trim();
    if (!clean) return;
    const now = Date.now();
    const { kvList, pushes, overlay } = get();
    const row = get().terminals.find((t) => t.id === id);
    if (row && pushes[row.machineId]) {
      // Pushed machine: write the title to the machine; the daemon stamps
      // @vh_title(+manual) and pushes immediately (setTitle kick). The
      // overlay renders the new title until that push confirms it.
      const nextOverlay: PushOverlay = {
        ...overlay,
        renames: { ...overlay.renames, [id]: { title: clean, at: now } },
      };
      set({ overlay: nextOverlay, terminals: composed(kvList, pushes, nextOverlay) });
      scheduleOverlaySweep(RENAME_OVERLAY_TTL_MS);
      void machineSetTerminalTitle(row.machineId, id, clean);
      return;
    }
    let machineId: string | undefined;
    const next = kvList.map((t) => {
      if (t.id !== id) return t;
      machineId = t.machineId;
      return { ...t, title: clean, manual: true, updatedAt: now, pendingTitle: true };
    });
    persistLocal(next);
    get().commitKv(next);
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
    const { kvList, pushes } = get();
    const row = get().terminals.find((t) => t.id === id);
    if (row && pushes[row.machineId]) {
      // Pushed machine: the caller (WebTerminalScreen) already sends the
      // fallback title to the machine via set-terminal-title(ifAbsent); the
      // confirming push carries it back within a round-trip. Nothing to do
      // locally — an optimistic value here could disagree with what ifAbsent
      // actually kept.
      return;
    }
    const next = kvList.map((t) =>
      t.id === id && !t.manual && t.title === t.machineName
        ? { ...t, title: clean, updatedAt: now }
        : t,
    );
    persistLocal(next);
    get().commitKv(next);
    scheduleKvPush();
  },
  remove: (id) => {
    const now = Date.now();
    const { kvList, pushes, overlay } = get();
    const row = get().terminals.find((t) => t.id === id);
    if (row && pushes[row.machineId]) {
      // Pushed machine: the caller already fired kill-terminal; hide the row
      // until the push confirms the tmux died (absence). If the kill never
      // lands (machine offline), the row honestly returns after the TTL —
      // unlike the legacy tombstone, which hid an alive terminal forever.
      const nextOverlay: PushOverlay = {
        ...overlay,
        removed: { ...overlay.removed, [id]: now },
        // A pending creation for the same id is simply dropped.
        created: overlay.created.filter((c) => c.id !== id),
      };
      set({ overlay: nextOverlay, terminals: composed(kvList, pushes, nextOverlay) });
      scheduleOverlaySweep(REMOVE_OVERLAY_TTL_MS);
      return;
    }
    // Legacy: tombstone, don't filter — the deletion must WIN the per-terminal
    // KV merge on other devices (see terminalListOps.ts).
    const next = kvList.map((t) =>
      t.id === id && !t.deletedAt ? { ...t, deletedAt: now, updatedAt: now } : t,
    );
    persistLocal(next);
    get().commitKv(next);
    scheduleKvPush();
  },
  reconcile: (machineId, machineName, live) => {
    if (live == null) return; // query failed → don't touch records
    if (get().pushes[machineId]) return; // pushed machine → the push is the truth
    const { next, pushTitles, changed } = reconcileWithMachine(
      get().kvList,
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
    get().commitKv(next);
    scheduleKvPush();
  },
  applyPush: (machineId, machineName, terminals) => {
    const { kvList, pushes, overlay } = get();
    const nextPushes = { ...pushes, [machineId]: { machineName, terminals } };
    const nextOverlay = pruneOverlay(overlay, nextPushes, Date.now());
    set({
      pushes: nextPushes,
      overlay: nextOverlay,
      terminals: composed(kvList, nextPushes, nextOverlay),
    });
  },
  clearPush: (machineId) => {
    const { kvList, pushes, overlay } = get();
    if (!pushes[machineId]) return;
    const nextPushes = { ...pushes };
    delete nextPushes[machineId];
    const nextOverlay = pruneOverlay(overlay, nextPushes, Date.now());
    set({
      pushes: nextPushes,
      overlay: nextOverlay,
      terminals: composed(kvList, nextPushes, nextOverlay),
    });
  },
  isPushed: (machineId) => !!get().pushes[machineId],
  sweepOverlay: () => {
    const { kvList, pushes, overlay } = get();
    // pruneOverlay applies the TTLs too, so a timed sweep both drops expired
    // entries and recomposes the rendered list (compose re-reads the clock).
    const nextOverlay = pruneOverlay(overlay, pushes, Date.now());
    set({ overlay: nextOverlay, terminals: composed(kvList, pushes, nextOverlay) });
  },
  commitKv: (kv) => {
    const { pushes, overlay } = get();
    set({ kvList: kv, terminals: composed(kv, pushes, overlay) });
  },
}));
