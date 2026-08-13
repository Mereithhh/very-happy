/**
 * activityOverlayStore — the two fast "last active" sources behind the
 * sidebar's realtime recent order. Rules live in activityOverlay.ts (pure);
 * this file is the store + persistence + render batching.
 *
 * ── local ──────────────────────────────────────────────────────────────────
 * Stamped by MY OWN actions in THIS browser (terminal keystrokes/paste,
 * opening+focusing a terminal, sending a chat message). Persisted to MMKV,
 * device-local like notificationPrefs / clipboardHistoryStore — deliberately
 * NOT synced: "what I was just doing" is a per-device fact, and a phone
 * floating rows on the desktop would be a bug, not a feature. Writes are
 * throttled (see LOCAL_WRITE_THROTTLE_MS) so per-keystroke stamping never
 * turns into per-keystroke localStorage traffic.
 *
 * ── remote ─────────────────────────────────────────────────────────────────
 * Fed by the daemon's ephemeral `terminal-activity` frames (terminalSync).
 * IN-MEMORY ONLY — it describes what is happening right now on machines we
 * are connected to; persisting it would only let a stale number outrank the
 * truth after a reload. Never written into daemonState or the terminal list
 * store: it is an ordering hint, not state.
 *
 * ── render batching ────────────────────────────────────────────────────────
 * Both lanes funnel through a coalescing buffer (REORDER_FLUSH_MS) so a burst
 * of frames — or a fast typist — produces at most one store write, and
 * therefore at most one sidebar re-derivation, per window. mergeActivity
 * additionally returns the SAME map when nothing actually moved, so a no-op
 * batch triggers no render at all.
 */
import { create } from 'zustand';
import { MMKV } from '@/storage/mmkv-web';
import {
  mergeActivity,
  parseActivityMap,
  EMPTY_ACTIVITY,
  LOCAL_ACTIVITY_CAP,
  REMOTE_ACTIVITY_CAP,
  type ActivityMap,
} from '@/sync/activityOverlay';

const store = new MMKV({ id: 'activity-overlay' });
const LOCAL_KEY = 'local-v1';

/**
 * How long a persisted LOCAL stamp stays meaningful. A week-old "I typed
 * here" is not a reason to float a row; a same-day one is exactly the reason
 * this layer exists.
 */
export const LOCAL_ACTIVITY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * ── Coalescing windows, which double as the anti-jitter damper ──────────────
 *
 * LOCAL is my own action, so it must feel instant — 120ms is below the
 * perceptual threshold for "the list responded to me" while still collapsing
 * a burst of keystrokes into ONE store write instead of one per key.
 *
 * REMOTE is output from machines, and it is the lane that can jitter: two
 * terminals both streaming would otherwise trade places as fast as frames
 * arrive, and a list that reshuffles several times a second is unreadable
 * even when every individual move is "correct". Flushing that lane on a 1s
 * boundary IS the minimum reorder interval — implemented as one number rather
 * than a stateful per-row damper, because it needs no extra timers, cannot
 * fight the hover freeze, and composes with the daemon's own ~1s throttle to
 * give at most one output-driven reorder per second end to end.
 *
 * The split matters: a shared window would have forced a choice between a
 * sluggish response to my own typing and a twitchy list. Separating them lets
 * my keystroke float a row in ~120ms while machine output stays capped at 1/s.
 */
export const LOCAL_FLUSH_MS = 120;
export const REMOTE_FLUSH_MS = 1_000;

/** Minimum gap between MMKV writes of the local map (the in-memory value is
 *  always current; only the durable copy lags, and losing the last <2s of
 *  stamps on a crash costs nothing). */
export const LOCAL_WRITE_THROTTLE_MS = 2_000;

interface ActivityOverlayState {
  local: ActivityMap;
  remote: ActivityMap;
  /** Apply a coalesced batch. Called only by the flush below. */
  applyBatch(local: Record<string, number>, remote: Record<string, number>): void;
}

/** No storage backend (unit tests, SSR, locked-down private mode) → the
 *  overlay still works for this session, it just doesn't survive a reload.
 *  Checked explicitly so we don't log a warning per write in those envs. */
function canPersist(): boolean {
  return typeof localStorage !== 'undefined';
}

function loadLocal(): ActivityMap {
  if (!canPersist()) return EMPTY_ACTIVITY;
  try {
    const raw = store.getString(LOCAL_KEY);
    if (!raw) return EMPTY_ACTIVITY;
    return parseActivityMap(JSON.parse(raw), Date.now(), LOCAL_ACTIVITY_MAX_AGE_MS, LOCAL_ACTIVITY_CAP);
  } catch {
    return EMPTY_ACTIVITY;
  }
}

export const useActivityOverlay = create<ActivityOverlayState>((set, get) => ({
  local: loadLocal(),
  remote: EMPTY_ACTIVITY,
  applyBatch: (local, remote) => {
    const prev = get();
    const nextLocal = mergeActivity(prev.local, local, LOCAL_ACTIVITY_CAP);
    const nextRemote = mergeActivity(prev.remote, remote, REMOTE_ACTIVITY_CAP);
    // Identity-stable when nothing moved → zustand skips the notify → the
    // sidebar memo doesn't even re-run.
    if (nextLocal === prev.local && nextRemote === prev.remote) return;
    set({ local: nextLocal, remote: nextRemote });
    if (nextLocal !== prev.local) scheduleLocalWrite(nextLocal);
  },
}));

// ── coalescing buffer ───────────────────────────────────────────────────────

let pendingLocal: Record<string, number> = {};
let pendingRemote: Record<string, number> = {};
let localTimer: ReturnType<typeof setTimeout> | null = null;
let remoteTimer: ReturnType<typeof setTimeout> | null = null;

const EMPTY_BATCH: Record<string, number> = {};

function scheduleLocalFlush() {
  if (localTimer) return;
  localTimer = setTimeout(() => {
    localTimer = null;
    const local = pendingLocal;
    pendingLocal = {};
    useActivityOverlay.getState().applyBatch(local, EMPTY_BATCH);
  }, LOCAL_FLUSH_MS);
}

function scheduleRemoteFlush() {
  if (remoteTimer) return;
  remoteTimer = setTimeout(() => {
    remoteTimer = null;
    const remote = pendingRemote;
    pendingRemote = {};
    useActivityOverlay.getState().applyBatch(EMPTY_BATCH, remote);
  }, REMOTE_FLUSH_MS);
}

/**
 * Layer 1: "I just interacted with this row myself" — the single entry point
 * for every local stamp. `key` is a sidebar row key (activityKeyForTerminal /
 * activityKeyForSession). Cheap enough to call per keystroke: it writes one
 * number into a plain object and (at most) arms one timer.
 */
export function stampLocalActivity(key: string, at: number = Date.now()): void {
  if (!key || typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return;
  if (at <= (pendingLocal[key] ?? 0)) return;
  if (at <= (useActivityOverlay.getState().local[key] ?? 0)) return;
  pendingLocal[key] = at;
  scheduleLocalFlush();
}

/**
 * Layer 2: one relayed `terminal-activity` frame. Terminal ids are globally
 * unique in this app (the terminal list is already composed across machines
 * by id), so the machine is not part of the key.
 */
export function applyRemoteTerminalActivity(terminals: Array<{ id: string; activityAt: number }>): void {
  let any = false;
  for (const t of terminals) {
    if (!t || typeof t.id !== 'string' || !t.id) continue;
    const at = t.activityAt;
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) continue;
    const key = `t:${t.id}`;
    pendingRemote[key] = Math.max(pendingRemote[key] ?? 0, at);
    any = true;
  }
  if (any) scheduleRemoteFlush();
}

// ── persistence (throttled) ─────────────────────────────────────────────────

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let writePending: ActivityMap | null = null;
let lastWriteAt = 0;

function writeLocal(map: ActivityMap) {
  lastWriteAt = Date.now();
  try {
    store.set(LOCAL_KEY, JSON.stringify(map));
  } catch {
    /* quota / private mode — the in-memory overlay still works this session */
  }
}

function scheduleLocalWrite(map: ActivityMap) {
  if (!canPersist()) return;
  writePending = map;
  if (writeTimer) return;
  const wait = LOCAL_WRITE_THROTTLE_MS - (Date.now() - lastWriteAt);
  if (wait <= 0) {
    writePending = null;
    writeLocal(map);
    return;
  }
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const pending = writePending;
    writePending = null;
    if (pending) writeLocal(pending);
  }, wait);
}

/** Test seam: drop every buffer/timer and the in-memory maps. */
export function __resetActivityOverlay(): void {
  if (localTimer) { clearTimeout(localTimer); localTimer = null; }
  if (remoteTimer) { clearTimeout(remoteTimer); remoteTimer = null; }
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  pendingLocal = {};
  pendingRemote = {};
  writePending = null;
  lastWriteAt = 0;
  useActivityOverlay.setState({ local: EMPTY_ACTIVITY, remote: EMPTY_ACTIVITY });
}
