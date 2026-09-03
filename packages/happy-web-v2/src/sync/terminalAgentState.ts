/**
 * terminalAgentState — lightweight store of each web terminal's Claude Code
 * status (`agentState` on the daemon's terminal-list items, daemon >= the
 * version that reports it). There is deliberately NO data acquisition here:
 * the singleton terminal sync (terminalSync.ts) is the only feeder — every
 * daemon push flows through `ingest()`, so alerts fire exactly once per
 * transition.
 *
 * Besides the {terminalId → state} map (consumed by the sidebar dot), ingest
 * owns the alerting side effects:
 *   - while ANY terminal is in `needs_input`, the tab title gets a "(!) "
 *     prefix (re-asserted on every ingest since other code rewrites the title);
 *   - on a *transition* to `needs_input` (previous value known and different),
 *     if the tab isn't focused and Notification permission is already granted,
 *     raise a foreground browser Notification (no permission prompts here —
 *     that flow stays in webNotifications.ts / settings).
 *
 * Old daemons don't report `agentState`: those terminals simply never get an
 * entry, and every consumer treats `undefined` as "keep the current UI".
 *
 * B-324 —— 未读红点也归这里，理由和 needs_input 告警同一条：ingest 是终端状态
 * **转换**的唯一观测点。判据是 `working` → `idle`/`shell`（一轮跑完了，或者
 * claude 直接退了），要求：
 *   ① 必须有 `before`——首次观测不算转换，否则重开页面会把每个空闲终端点亮；
 *   ② 当前没在看这个终端（`viewingTerminalId`，由 WebTerminalRoute 挂载时登记）。
 * `working` → `needs_input` **不**标未读：那一档由 attention（青色）表达，且
 * rowSignalOf 里 attention 本来就压过 unread，重复标记只会在它转 idle 之后留下
 * 一个已经被处理过的红点。
 *
 * 为什么不复用 storage.unreadSessionIds：两者由不同的 store、不同的信号标记，
 * 也由不同的路由清除；而且**终端这一档刻意不看机器是否在线**——会话那半正是被
 * 「离线就不画」拦掉的（B-312 的已知缺口），跑完了就是跑完了，机器后来掉线不该
 * 让这个提醒消失。
 */
import { create } from 'zustand';
import { t } from '@/text';
import type { MachineTerminal, TerminalAgentState } from '@/sync/ops';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { loadUnreadTerminalIds, saveUnreadTerminalIds } from '@/sync/persistence';

export interface TerminalAgentEntry {
  machineId: string;
  state: TerminalAgentState;
  /** Working directory reported by the daemon (newer daemons only). */
  cwd?: string;
  /** When we first observed the CURRENT state (ingest-side clock). */
  since?: number;
  /** tmux session_activity in ms (newer daemons only). */
  activityAt?: number;
}

interface TerminalAgentStates {
  /** terminalId → last known agent state (only terminals whose daemon reports it). */
  states: Record<string, TerminalAgentEntry>;
  /** B-324: terminals whose agent finished a run while the user was elsewhere. */
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
function notifyNeedsInput(terminalId: string, terminalTitle: string) {
  if (isTabFocused()) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const notification = new Notification(terminalTitle, {
      body: t('terminal.claudeNeedsInputBody'),
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
      const state = term.agentState;
      if (!state) continue; // old daemon → stay unknown, keep current UI
      const before = prev[term.id];
      if (
        before &&
        before.machineId === machineId &&
        before.state === state &&
        before.cwd === term.cwd &&
        before.activityAt === term.activityAt
      ) {
        next[term.id] = before; // keep identity, avoid churn
      } else if (before && before.machineId === machineId && before.state === state) {
        // Same state, refreshed extras (cwd / tmux activity) — keep `since`
        // (it marks the state transition, not the freshest listing).
        next[term.id] = { ...before, cwd: term.cwd, activityAt: term.activityAt };
        changed = true;
      } else {
        next[term.id] = {
          machineId,
          state,
          cwd: term.cwd,
          activityAt: term.activityAt,
          since: Date.now(),
        };
        changed = true;
        // Alert only on a real transition INTO needs_input — not on the first
        // observation after load, so reopening the app doesn't replay alerts.
        // B-324: a run that ended while the user was looking elsewhere.
        if (
          before &&
          before.machineId === machineId &&
          before.state === 'working' &&
          (state === 'idle' || state === 'shell') &&
          term.id !== viewing &&
          !unread.has(term.id)
        ) {
          unread = new Set(unread);
          unread.add(term.id);
        }
        if (state === 'needs_input' && before && before.state !== 'needs_input') {
          const record = useTerminalSessions
            .getState()
            .terminals.find((x) => x.id === term.id);
          const title =
            record?.title || term.title?.trim() || record?.machineName || 'Terminal';
          notifyNeedsInput(term.id, title);
        }
      }
    }

    if (!changed && Object.keys(next).length !== Object.keys(prev).length) changed = true;
    // Mirror to MMKV only when the set actually grew — ingest runs on every
    // daemon push and an unchanged set must not cost a write (B-312's rule).
    if (unread !== get().unread) saveUnreadTerminalIds(unread);
    if (changed || unread !== get().unread) set({ ...(changed ? { states: next } : {}), unread });
    // Re-assert every ingest (idempotent): navigation may have rewritten the title.
    const current = changed ? next : prev;
    applyTitleFlag(Object.values(current).some((e) => e.state === 'needs_input'));
  },
}));

/** Subscribe to one terminal's Claude state (undefined = unknown / old daemon). */
export function useTerminalAgentState(terminalId: string | undefined): TerminalAgentState | undefined {
  return useTerminalAgentStates((s) => (terminalId ? s.states[terminalId]?.state : undefined));
}
