import { codingAgentLabel } from './agentStatus';
import { recordHeartbeat, isHeartbeatFresh, forgetHeartbeat, useHeartbeatLeaseBump } from './heartbeatLease';
/** Agent identity/execution observations from the singleton terminal sync.
 * Receipt-time leases expire stale observations; unread remains independent.
 * Only fresh, same-agent transitions may produce completion/input alerts.
 */
import { create } from 'zustand';
import { t } from '@/text';
import type { MachineTerminal, TerminalAgentState } from '@/sync/ops';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { loadUnreadTerminalIds, saveUnreadTerminalIds } from '@/sync/persistence';

export interface TerminalAgentEntry {
  machineId: string;
  state: TerminalAgentState | undefined;
  agentKind?: string;
  agentObservedAt?: number;
  /** Working directory reported by the daemon (newer daemons only). */
  cwd?: string;
  /** When we first observed the CURRENT state (ingest-side clock). */
  since?: number;
  /** tmux session_activity in ms (newer daemons only). */
  activityAt?: number;
}

interface TerminalAgentStates {
  machineOnline: Record<string, boolean>;
  setMachineOnline(online: Record<string, boolean>): void;
  /** terminalId → last known agent state (only terminals whose daemon reports it). */
  states: Record<string, TerminalAgentEntry>;
  /** B-330: terminals whose agent finished a run while the user was elsewhere. */
  unread: Set<string>;
  /** The terminal the user currently has open, if any (WebTerminalRoute owns it). */
  viewingTerminalId: string | null;
  /** Feed one machine's pushed terminal list (daemonState.webTerminals). */
  ingest(machineId: string, terminals: MachineTerminal[]): void;
  setViewingTerminal(terminalId: string | null): void;
  markTerminalRead(terminalId: string): void;
}

/** Prefix the tab title with "(!) " while some terminal needs input.
 *  Strips every prior "(!) " first so re-applies are idempotent and we don't
 *  fight webTabTitle's own "(N) " unread prefix. */
function applyTitleFlag(active: boolean) {
  if (typeof document === 'undefined') return;
  const stripped = document.title.replace(/\(!\)\s*/g, '');
  const next = active ? `(!) ${stripped}` : stripped;
  if (next !== document.title) document.title = next;
}

function isTabFocused(): boolean {
  if (typeof document === 'undefined') return true;
  const visible = document.visibilityState === 'visible';
  const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
  return visible && focused;
}

/** Foreground Notification for a needs_input transition. Only uses an already
 *  granted permission; never requests one. Best-effort, never throws. */
function notifyNeedsInput(terminalId: string, terminalTitle: string, agentKind?: string) {
  if (isTabFocused()) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const notification = new Notification(terminalTitle, {
      body: t('terminal.agentNeedsInputBody', { agent: codingAgentLabel(agentKind) }),
      tag: `vh-term-agent-${terminalId}`, // newer alert for same terminal replaces older
    });
    notification.onclick = () => {
      try {
        window.focus();
      } catch {
        // focus is best-effort
      }
      notification.close();
    };
  } catch {
    // Notification constructor can throw (e.g. some mobile browsers) — ignore
  }
}

export const useTerminalAgentStates = create<TerminalAgentStates>((set, get) => ({
  states: {},
  machineOnline: {},
  setMachineOnline: (online) => {
    const before = get().machineOnline;
    if (Object.keys(before).length === Object.keys(online).length && Object.entries(online).every(([id, value]) => before[id] === value)) return;
    set({ machineOnline: online });
    refreshTerminalTitleFlag();
  },
  unread: new Set<string>(loadUnreadTerminalIds()),
  viewingTerminalId: null,
  setViewingTerminal: (terminalId) => set({ viewingTerminalId: terminalId }),
  markTerminalRead: (terminalId) => set((state) => {
    if (!state.unread.has(terminalId)) return state;
    const unread = new Set(state.unread);
    unread.delete(terminalId);
    saveUnreadTerminalIds(unread);
    return { unread };
  }),
  ingest: (machineId, terminals) => {
    const prev = get().states;
    const viewing = get().viewingTerminalId;
    let unread = get().unread;
    const next: Record<string, TerminalAgentEntry> = {};
    let changed = false;

    // Entries owned by OTHER machines carry over untouched; this machine's
    // entries are rebuilt from the fresh listing (a vanished terminal or a
    // daemon that stopped reporting agentState drops back to undefined).
    for (const [id, entry] of Object.entries(prev)) {
      if (entry.machineId !== machineId) next[id] = entry;
    }

    for (const term of terminals) {
      const state = ['working', 'needs_input', 'idle', 'shell'].includes(term.agentState ?? '') ? term.agentState : undefined;
      const agentKind = ['claude', 'codex', 'pi'].includes(term.agentKind ?? '') ? term.agentKind : undefined;
      const observedAt = typeof term.agentObservedAt === 'number' && Number.isFinite(term.agentObservedAt) && term.agentObservedAt > 0 ? term.agentObservedAt : undefined;
      if (!state && !term.agentObservedAt && !term.agentKind) continue; // old daemon → stay unknown, keep current UI
      const before = prev[term.id];
      if (before?.machineId === machineId && observedAt && before.agentObservedAt && (observedAt < before.agentObservedAt || (observedAt === before.agentObservedAt && (state !== before.state || agentKind !== before.agentKind)))) {
        next[term.id] = before; // delayed/replayed observation cannot rewind state or renew its lease
        continue;
      }
      const continuous = get().machineOnline[machineId] !== false && !!before && before.machineId === machineId &&
        (before.agentKind === agentKind || state === 'shell') && isTerminalStatusFresh(term.id, before);
      const newObservation = !!observedAt && (before?.machineId !== machineId || before.agentObservedAt !== observedAt);
      if (newObservation) recordHeartbeat(terminalLeaseKey(machineId, term.id), true, Date.now(), TERMINAL_STATUS_TTL_MS);

      if (
        before &&
        before.machineId === machineId &&
        before.state === state &&
        before.agentKind === agentKind &&
        before.agentObservedAt === observedAt &&
        before.cwd === term.cwd &&
        before.activityAt === term.activityAt
      ) {
        next[term.id] = before; // keep identity, avoid churn
      } else if (before && before.machineId === machineId && before.state === state && before.agentKind === agentKind) {
        // Same state, refreshed extras (cwd / tmux activity) — keep `since`
        // (it marks the state transition, not the freshest listing).
        next[term.id] = { ...before, agentKind, agentObservedAt: observedAt, cwd: term.cwd, activityAt: term.activityAt };
        changed = true;
      } else {
        next[term.id] = {
          machineId,
          state,
          agentKind,
          agentObservedAt: observedAt,
          cwd: term.cwd,
          activityAt: term.activityAt,
          since: Date.now(),
        };
        changed = true;
        // Alert only on a real transition INTO needs_input — not on the first
        // observation after load, so reopening the app doesn't replay alerts.
        // B-330: a run that ended while the user was looking elsewhere.
        if (
          before &&
          before.machineId === machineId &&
          continuous && newObservation &&
          before.state === 'working' &&
          (state === 'idle' || state === 'shell') &&
          term.id !== viewing &&
          !unread.has(term.id)
        ) {
          unread = new Set(unread);
          unread.add(term.id);
        }
        // B-360: `before.machineId === machineId` here for the same reason the
        // unread branch above requires it — when two machine rows share a host
        // (a rotated machine id), the retired row's frozen entry is not a
        // previous state of THIS owner, and treating it as one replayed an
        // alert on every load.
        if (
          state === 'needs_input' &&
          before &&
          before.machineId === machineId &&
          continuous && newObservation &&
          before.state !== 'needs_input'
        ) {
          const record = useTerminalSessions
            .getState()
            .terminals.find((x) => x.id === term.id);
          const title =
            record?.title || term.title?.trim() || record?.machineName || 'Terminal';
          notifyNeedsInput(term.id, title, agentKind);
        }
      }
    }

    for (const [id, old] of Object.entries(prev)) {
      if (old.machineId === machineId && !next[id]) forgetHeartbeat(terminalLeaseKey(machineId, id));
    }
    if (!changed && Object.keys(next).length !== Object.keys(prev).length) changed = true;
    // Mirror to MMKV only when the set actually grew — ingest runs on every
    // daemon push and an unchanged set must not cost a write (B-312's rule).
    if (unread !== get().unread) saveUnreadTerminalIds(unread);
    if (changed || unread !== get().unread) set({ ...(changed ? { states: next } : {}), unread });
    // Re-assert every ingest (idempotent): navigation may have rewritten the title.
    refreshTerminalTitleFlag();
  },
}));

/** Subscribe to one terminal's fresh coding-agent state (undefined = unknown / old daemon). */
export function useTerminalAgentState(terminalId: string | undefined): TerminalAgentState | undefined {
  useHeartbeatLeaseBump(s => s.bump);
  const entry = useTerminalAgentStates(s => terminalId ? s.states[terminalId] : undefined);
  const online = useTerminalAgentStates(s => entry ? s.machineOnline[entry.machineId] !== false : false);
  return online && terminalId && isTerminalStatusFresh(terminalId, entry) ? entry?.state : undefined;
}

export const TERMINAL_STATUS_TTL_MS = 45_000;
export const terminalLeaseKey = (machineId: string, terminalId: string) => `terminal:${machineId}:${terminalId}`;
export function isTerminalStatusFresh(terminalId: string, entry: TerminalAgentEntry | undefined, now = Date.now()): boolean {
  return !!entry?.agentObservedAt && isHeartbeatFresh(terminalLeaseKey(entry.machineId, terminalId), now, TERMINAL_STATUS_TTL_MS);
}

function refreshTerminalTitleFlag() {
  const { states, machineOnline } = useTerminalAgentStates.getState();
  applyTitleFlag(Object.entries(states).some(([id, entry]) => machineOnline[entry.machineId] !== false && entry.state === 'needs_input' && isTerminalStatusFresh(id, entry)));
}
// Reuse lease expiry; no new polling or connection/visibility listener.
useHeartbeatLeaseBump.subscribe(refreshTerminalTitleFlag);
