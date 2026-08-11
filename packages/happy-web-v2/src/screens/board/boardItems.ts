/**
 * boardItems — pure derivation of the global Task Board from state the app
 * already holds: chat sessions (socket-pushed), the terminal registry
 * (KV-backed) and per-terminal agent states (fed by the singleton reconcile
 * loop). NO new data source, NO polling, NO store imports — everything comes
 * in as arguments so the mapping stays unit-testable (see boardItems.test.ts,
 * same pattern as terminalListOps.ts).
 *
 * Status mapping (V1, per the task-board plan):
 *
 *   chat session   attention: presence==='online' && pending permission requests
 *                  working:   active && thinking
 *                  idle:      active && presence==='online' (not thinking)
 *                  ended:     !active or presence lost, within the 24h window
 *   terminal       attention: agentState 'needs_input'  — machine ONLINE only
 *                  working:   'working'
 *                  idle:      'idle' / 'shell' / undefined (old daemon)
 *                  ended:     its machine is offline ("machine offline"),
 *                             within the 24h window
 *
 * Hard rule: a machine going offline can NEVER leave its terminals parked in
 * the attention column on a stale needs_input — offline gates everything.
 * The board only shows operations in flight: ended items older than
 * ENDED_WINDOW_MS fall off entirely (the sidebar's archived filter is the
 * history view, not the board).
 */
import type { Session, Machine } from '@/sync/storageTypes';
import type { TerminalSession } from '@/sync/terminalListOps';
import type { TerminalAgentEntry } from '@/sync/terminalAgentState';

export type BoardStatus = 'attention' | 'working' | 'idle' | 'ended';

/** Structured one-liner under the title; the card translates it (pure module
 *  — no i18n imports here). */
export type BoardDetail =
  | { kind: 'tool'; name: string }
  | { kind: 'machineOffline' };

export interface BoardItem {
  /** session id, or `t:<terminalId>` */
  key: string;
  kind: 'session' | 'terminal';
  status: BoardStatus;
  /** raw title — may be '' for an unnamed chat; the card renders a fallback */
  title: string;
  machineName: string;
  cwd: string;
  /** sort driver (most recent first inside working/idle/ended) */
  lastActivityAt: number;
  /** set for attention items — oldest first ("waiting 4m" badge) */
  attentionSince?: number;
  href: string;
  detail?: BoardDetail;
}

/** ended items older than this fall off the board entirely */
export const ENDED_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface BoardInput {
  /** all chat sessions (useAllSessions — NOT useSessions, which mixes group headers) */
  sessions: Session[];
  /** terminal registry records (useTerminalSessions) */
  terminals: TerminalSession[];
  /** terminalId → agent entry (useTerminalAgentStates) */
  agentStates: Record<string, TerminalAgentEntry>;
  /** all machines incl. offline (useAllMachines({includeOffline:true})) */
  machines: Machine[];
  now: number;
}

/** ~/-relative path (standalone twin of sessionUtils.formatPathRelativeToHome,
 *  which can't be imported here without dragging the i18n runtime into tests). */
export function formatCwd(path: string | undefined, homeDir?: string): string {
  if (!path) return '';
  if (homeDir) {
    const home = homeDir.endsWith('/') ? homeDir.slice(0, -1) : homeDir;
    if (path === home) return '~';
    if (path.startsWith(home + '/')) return '~' + path.slice(home.length);
  }
  return path;
}

function sessionHasPendingRequests(s: Session): boolean {
  return !!s.agentState?.requests && Object.keys(s.agentState.requests).length > 0;
}

/** earliest pending request: drives attentionSince + the tool-name detail */
function earliestRequest(s: Session, fallback: number): { at: number; tool?: string } {
  const requests = s.agentState?.requests ?? {};
  let at = Number.POSITIVE_INFINITY;
  let tool: string | undefined;
  for (const req of Object.values(requests)) {
    const t = req.createdAt ?? fallback;
    if (t < at) {
      at = t;
      tool = req.tool;
    }
  }
  return Number.isFinite(at) ? { at, tool } : { at: fallback };
}

function machineName(machines: Machine[], machineId: string | undefined): string {
  if (!machineId) return '';
  const m = machines.find((x) => x.id === machineId);
  return m?.metadata?.displayName || m?.metadata?.host || machineId.slice(0, 8);
}

function machineOnline(machines: Machine[], machineId: string | undefined): boolean {
  if (!machineId) return false;
  const m = machines.find((x) => x.id === machineId);
  return !!m && m.active; // unknown machine → treated as offline
}

function classifySession(s: Session, now: number): { status: BoardStatus } | null {
  if (s.presence === 'online' && sessionHasPendingRequests(s)) return { status: 'attention' };
  if (s.active && s.thinking) return { status: 'working' };
  if (s.active && s.presence === 'online') return { status: 'idle' };
  const endedAt = s.updatedAt || s.activeAt || s.createdAt;
  if (now - endedAt <= ENDED_WINDOW_MS) return { status: 'ended' };
  return null; // older history — not the board's business
}

export function buildBoardItems(input: BoardInput): BoardItem[] {
  const { sessions, terminals, agentStates, machines, now } = input;
  const items: BoardItem[] = [];

  for (const s of sessions) {
    const cls = classifySession(s, now);
    if (!cls) continue;
    const lastActivityAt = s.updatedAt || s.activeAt || s.createdAt;
    const item: BoardItem = {
      key: s.id,
      kind: 'session',
      status: cls.status,
      title: s.metadata?.summary?.text ?? '',
      machineName: machineName(machines, s.metadata?.machineId) || s.metadata?.host || '',
      cwd: formatCwd(s.metadata?.path, s.metadata?.homeDir),
      lastActivityAt,
      href: `/session/${s.id}`,
    };
    if (cls.status === 'attention') {
      const req = earliestRequest(s, lastActivityAt);
      item.attentionSince = req.at;
      if (req.tool) item.detail = { kind: 'tool', name: req.tool };
    }
    items.push(item);
  }

  for (const tm of terminals) {
    const entry = agentStates[tm.id];
    const online = machineOnline(machines, tm.machineId);
    const lastActivityAt = entry?.activityAt ?? tm.updatedAt ?? tm.createdAt;
    let status: BoardStatus;
    let detail: BoardDetail | undefined;
    let attentionSince: number | undefined;
    if (!online) {
      // Offline machine: its stale agent state means nothing — NEVER attention.
      if (now - lastActivityAt > ENDED_WINDOW_MS) continue;
      status = 'ended';
      detail = { kind: 'machineOffline' };
    } else if (entry?.state === 'needs_input') {
      status = 'attention';
      attentionSince = entry.since ?? lastActivityAt;
    } else if (entry?.state === 'working') {
      status = 'working';
    } else {
      // idle / shell / undefined (old daemon — unknown is NOT attention)
      status = 'idle';
    }
    items.push({
      key: `t:${tm.id}`,
      kind: 'terminal',
      status,
      title: tm.title || tm.machineName,
      machineName: tm.machineName,
      cwd: formatCwd(entry?.cwd),
      lastActivityAt,
      attentionSince,
      href: `/terminal/${tm.machineId}?tid=${tm.id}`,
      detail,
    });
  }

  // Total order (a consistent comparator — mixing per-group rules without a
  // primary key would make Array.sort unstable): status rank first, then
  // attention = longest-waiting FIRST, others = most recent activity first.
  // Key tiebreak keeps the order stable across polls (no column jitter).
  const RANK: Record<BoardStatus, number> = { attention: 0, working: 1, idle: 2, ended: 3 };
  items.sort((a, b) => {
    const r = RANK[a.status] - RANK[b.status];
    if (r !== 0) return r;
    const d =
      a.status === 'attention'
        ? (a.attentionSince ?? 0) - (b.attentionSince ?? 0)
        : b.lastActivityAt - a.lastActivityAt;
    return d !== 0 ? d : a.key.localeCompare(b.key);
  });
  return items;
}
