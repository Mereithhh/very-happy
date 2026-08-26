/**
 * Registry of web terminal sessions — the ONE list every consumer renders
 * (sidebar, board, palette, picker, terminal screen).
 *
 * Single truth model (daemon push — see terminalPushOps.ts): each machine's
 * daemonState.webTerminals IS its terminal list. Fed by terminalSync via
 * `applyPush()`; mutations go straight to the machine over RPC and render
 * optimistically through a small TTL overlay until the confirming push lands.
 * No client-side persistence, no KV writes, no tombstones — deletion
 * propagates by absence from the push, and OFFLINE machines still display
 * because the server persists their last daemonState.
 *
 * (The legacy poll+KV lane — `vh.terminal-sessions` records, MMKV cache, 10s
 * reconcile, per-terminal merge, deletion tombstones — was retired 2026-08:
 * the web now requires a push-capable daemon, >= 0.2.27. Server-side KV
 * records are left untouched for any old clients still reading them; this
 * client neither reads nor writes them.)
 *
 * Titles: the machine's tmux `@vh_title` is the cross-device truth. A rename
 * writes it over RPC and the daemon pushes the confirmation immediately
 * (setTitle kick); the overlay renders the new title until that push lands.
 */
import { create } from 'zustand';
import { machineSetTerminalTags, machineSetTerminalTitle, type MachineTerminal } from '@/sync/ops';
import {
  composeTerminalList,
  pruneOverlay,
  EMPTY_OVERLAY,
  CREATE_OVERLAY_TTL_MS,
  RENAME_OVERLAY_TTL_MS,
  REMOVE_OVERLAY_TTL_MS,
  type MachinePush,
  type PushOverlay,
  type TerminalSession,
} from '@/sync/terminalPushOps';

export type { TerminalSession } from '@/sync/terminalPushOps';

// The retired KV lane's local MMKV cache (see header). One-time cleanup so
// long-lived browser profiles don't carry a dead blob forever; the mmkv-web
// backing store is plain localStorage with a `mmkv:default:` prefix.
try {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('mmkv:default:terminal-sessions-cache-v2');
  }
} catch {
  /* best-effort */
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

/** Timed overlay entries (optimistic create/rename/remove) need a sweep at
 *  their TTL even if no push arrives — otherwise an expired entry lingers
 *  until the next unrelated store event. */
function scheduleOverlaySweep(ttlMs: number) {
  setTimeout(() => useTerminalSessions.getState().sweepOverlay(), ttlMs + 100);
}

interface TerminalSessionsState {
  /** The composed list every consumer renders (pushes ∪ overlay). */
  terminals: TerminalSession[];
  /** machineId → applied push (trusted daemonState.webTerminals snapshots). */
  pushes: Record<string, MachinePush>;
  /** Optimistic overlay for local mutations. */
  overlay: PushOverlay;
  create(machineId: string, machineName: string, title?: string): TerminalSession;
  update(id: string, changes: { title?: string; tags?: string[] }): void;
  remove(id: string): void;
  /** Apply one machine's trusted webTerminals snapshot (terminalSync). */
  applyPush(machineId: string, machineName: string, terminals: MachineTerminal[]): void;
  /** The machine's snapshot lost trust (daemon downgrade) → stop rendering it. */
  clearPush(machineId: string): void;
  /** Drop expired overlay entries (timed sweep). */
  sweepOverlay(): void;
}

/** Recompose the rendered list from the two sources. */
function composed(pushes: Record<string, MachinePush>, overlay: PushOverlay): TerminalSession[] {
  return composeTerminalList(pushes, overlay, Date.now());
}

export const useTerminalSessions = create<TerminalSessionsState>((set, get) => ({
  terminals: [],
  pushes: {},
  overlay: EMPTY_OVERLAY,
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
    // The terminal becomes real when the terminal screen's `open-terminal`
    // creates the tmux session and the daemon pushes it. Until then (or the
    // TTL, if the open never happens) this overlay row is the only place it
    // exists.
    const { pushes, overlay } = get();
    const nextOverlay: PushOverlay = { ...overlay, created: [t, ...overlay.created] };
    set({ overlay: nextOverlay, terminals: composed(pushes, nextOverlay) });
    scheduleOverlaySweep(CREATE_OVERLAY_TTL_MS);
    return t;
  },
  update: (id, changes) => {
    const row = get().terminals.find((t) => t.id === id);
    if (!row) return;
    const cleanTitle = changes.title?.trim();
    if (changes.title !== undefined && !cleanTitle) return;
    // tags === undefined is also the old-daemon capability marker. Never send
    // an RPC that the owning daemon has not advertised support for.
    const nextTags = changes.tags !== undefined && row.tags !== undefined ? changes.tags : undefined;
    if (cleanTitle === undefined && nextTags === undefined) return;
    // Write the title to the machine; the daemon stamps @vh_title(+manual)
    // and pushes immediately (setTitle kick). The overlay renders the new
    // title until that push confirms it — or honestly reverts at the TTL if
    // the rename never landed (machine offline).
    const { pushes, overlay } = get();
    const pending = overlay.renames[id];
    const nextOverlay: PushOverlay = {
      ...overlay,
      renames: {
        ...overlay.renames,
        [id]: {
          ...(pending?.title !== undefined ? { title: pending.title } : {}),
          ...(pending?.tags !== undefined ? { tags: pending.tags } : {}),
          ...(cleanTitle !== undefined ? { title: cleanTitle } : {}),
          ...(nextTags !== undefined ? { tags: nextTags } : {}),
          at: Date.now(),
        },
      },
    };
    set({ overlay: nextOverlay, terminals: composed(pushes, nextOverlay) });
    scheduleOverlaySweep(RENAME_OVERLAY_TTL_MS);
    if (cleanTitle !== undefined) void machineSetTerminalTitle(row.machineId, id, cleanTitle);
    if (nextTags !== undefined) void machineSetTerminalTags(row.machineId, id, nextTags);
  },
  remove: (id) => {
    // The caller already fired kill-terminal; hide the row until the push
    // confirms the tmux died (absence). If the kill never lands (machine
    // offline), the row honestly returns after the TTL.
    const { pushes, overlay } = get();
    const nextOverlay: PushOverlay = {
      ...overlay,
      removed: { ...overlay.removed, [id]: Date.now() },
      // A pending creation for the same id is simply dropped.
      created: overlay.created.filter((c) => c.id !== id),
    };
    set({ overlay: nextOverlay, terminals: composed(pushes, nextOverlay) });
    scheduleOverlaySweep(REMOVE_OVERLAY_TTL_MS);
  },
  applyPush: (machineId, machineName, terminals) => {
    const { pushes, overlay } = get();
    const nextPushes = { ...pushes, [machineId]: { machineName, terminals } };
    const nextOverlay = pruneOverlay(overlay, nextPushes, Date.now());
    set({
      pushes: nextPushes,
      overlay: nextOverlay,
      terminals: composed(nextPushes, nextOverlay),
    });
  },
  clearPush: (machineId) => {
    const { pushes, overlay } = get();
    if (!pushes[machineId]) return;
    const nextPushes = { ...pushes };
    delete nextPushes[machineId];
    const nextOverlay = pruneOverlay(overlay, nextPushes, Date.now());
    set({
      pushes: nextPushes,
      overlay: nextOverlay,
      terminals: composed(nextPushes, nextOverlay),
    });
  },
  sweepOverlay: () => {
    const { pushes, overlay } = get();
    // pruneOverlay applies the TTLs too, so a timed sweep both drops expired
    // entries and recomposes the rendered list (compose re-reads the clock).
    const nextOverlay = pruneOverlay(overlay, pushes, Date.now());
    set({ overlay: nextOverlay, terminals: composed(pushes, nextOverlay) });
  },
}));
