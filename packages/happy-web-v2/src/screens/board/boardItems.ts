/**
 * boardItems — pure derivation of the global Task Board from state the app
 * already holds: chat sessions (socket-pushed), the terminal registry and
 * per-terminal agent states (both fed by the singleton terminal sync's
 * daemon pushes). NO new data source, NO polling, NO store imports —
 * everything comes in as arguments so the mapping stays unit-testable
 * (see boardItems.test.ts).
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
import type { TerminalSession } from '@/sync/terminalPushOps';
import type { TerminalAgentEntry } from '@/sync/terminalAgentState';
import { compareTaskOrder, type BoardTask } from '@/sync/boardTaskOps';
import { isHiddenSession } from '@/assistant/assistantSession';
import { hasPriorityTag } from '@/utils/tags';

export type BoardStatus = 'attention' | 'working' | 'idle' | 'ended';

//
// Lifecycle view (the default board): management flips from process state to
// task completion. Only two live buckets — an agent is either running or the
// item is waiting on the user ("跑完没收货 = 等我看"); DONE is not a status
// but an explicit user action that removes the item and leaves a record
// (buildCompletedEntries). The four-state BoardStatus above is retired to a
// per-card badge + the intra-column ordering source; its derivation stays.
//

export type BoardLifecycle = 'running' | 'waiting';

/** Why a waiting item needs the user — drives the card's reason badge and
 *  the urgent-band/reap-band split inside the waiting column. */
export type WaitReason =
  | 'permission' // pending permission request (urgent)
  | 'review' // LLM suggests a look (urgent)
  | 'blocked' // LLM says it's stuck (urgent)
  | 'needsInput' // terminal needs input (urgent)
  | 'idle' // agent finished / awaits new input, not marked done (reap)
  | 'ended' // process died un-archived, within 24h (reap)
  | 'machineOffline'; // terminal's machine offline, within 24h (reap)

/** Reasons that make a waiting item urgent (blocked on the user right now)
 *  vs. the reap band ("finished — collect it"). */
export const URGENT_WAIT_REASONS: ReadonlySet<WaitReason> = new Set([
  'permission',
  'review',
  'blocked',
  'needsInput',
]);

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
  /** V2: one-line progress note from the daemon-side LLM analysis */
  progress?: string;
  /** V2: LLM attention verdict ('review'/'blocked' → badge; folds into the
   *  attention column for online sessions — V1 gates unchanged) */
  llmAttention?: 'review' | 'blocked';
  /** V2: LLM task classification (grouping FALLBACK only — the manual
   *  dispatch mapping in BoardTask.sessionIds wins) */
  llmTaskId?: string;
  /** terminals only: the owning machine (card actions need it) */
  machineId?: string;
  /** lifecycle view: running (agent working) or waiting (needs the user) */
  lifecycle: BoardLifecycle;
  /** set iff lifecycle === 'waiting' */
  waitReason?: WaitReason;
  /** B-091: session carries the priority tag — floats first WITHIN its
   *  status band (never above the urgent/attention band; 优先 ≠ 紧急). */
  priority?: boolean;
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

/** 'review'/'blocked' verdict from the daemon-side analyzer, or undefined. */
function llmAttentionOf(s: Session): 'review' | 'blocked' | undefined {
  const a = s.metadata?.board?.attention;
  return a === 'review' || a === 'blocked' ? a : undefined;
}

function classifySession(s: Session, now: number): { status: BoardStatus } | null {
  // V2: an LLM 'review'/'blocked' verdict folds into attention, but ONLY for
  // online sessions — the V1 presence gate stays, so a dead session's stale
  // verdict can't park it in the attention column forever.
  if (s.presence === 'online' && (sessionHasPendingRequests(s) || llmAttentionOf(s))) {
    return { status: 'attention' };
  }
  if (s.active && s.thinking) return { status: 'working' };
  if (s.active && s.presence === 'online') return { status: 'idle' };
  // Archived (user explicitly dismissed it) never shows on the board — the
  // archived filter in the sidebar is its home. 'ended' is only for sessions
  // whose process died but nobody archived yet ("刚跑完还没看" reminders).
  if (!s.active) return null;
  const endedAt = s.updatedAt || s.activeAt || s.createdAt;
  if (now - endedAt <= ENDED_WINDOW_MS) return { status: 'ended' };
  return null; // older history — not the board's business
}

/**
 * The lifecycle classifier — the decision table (each row is a unit test in
 * boardItems.test.ts):
 *
 * | kind     | status    | extra                      | lifecycle | waitReason     |
 * |----------|-----------|----------------------------|-----------|----------------|
 * | session  | attention | pending permission request | waiting   | permission     |
 * | session  | attention | llmAttention='review'      | waiting   | review         |
 * | session  | attention | llmAttention='blocked'     | waiting   | blocked        |
 * | session  | working   |                            | running   | —              |
 * | session  | idle      |                            | waiting   | idle           |
 * | session  | ended     | (24h window)               | waiting   | ended          |
 * | terminal | attention | needs_input                | waiting   | needsInput     |
 * | terminal | working   |                            | running   | —              |
 * | terminal | idle      | idle/shell/unknown         | waiting   | idle           |
 * | terminal | ended     | machine offline (24h)      | waiting   | machineOffline |
 *
 * A pending permission request outranks an LLM verdict on the same session
 * (matching classifySession, which lets the request drive detail/since).
 */
export function lifecycleOf(
  item: Pick<BoardItem, 'kind' | 'status' | 'detail' | 'llmAttention'>,
): { lifecycle: BoardLifecycle; waitReason?: WaitReason } {
  if (item.status === 'working') return { lifecycle: 'running' };
  if (item.status === 'attention') {
    if (item.kind === 'terminal') return { lifecycle: 'waiting', waitReason: 'needsInput' };
    // Session: a tool detail means a real permission request is pending;
    // otherwise the attention came from the LLM verdict. A request without a
    // tool name still classifies as permission (the fallback).
    if (item.detail?.kind === 'tool') return { lifecycle: 'waiting', waitReason: 'permission' };
    if (item.llmAttention) return { lifecycle: 'waiting', waitReason: item.llmAttention };
    return { lifecycle: 'waiting', waitReason: 'permission' };
  }
  if (item.status === 'ended') {
    return {
      lifecycle: 'waiting',
      waitReason: item.detail?.kind === 'machineOffline' ? 'machineOffline' : 'ended',
    };
  }
  return { lifecycle: 'waiting', waitReason: 'idle' };
}

export function buildBoardItems(input: BoardInput): BoardItem[] {
  const { sessions, terminals, agentStates, machines, now } = input;
  const items: BoardItem[] = [];

  for (const s of sessions) {
    // B-053/B-105: hidden sessions (assistant, terminal mirrors) are not
    // tasks — presence/attention judgments are meaningless for a mirror.
    if (isHiddenSession(s)) continue;
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
      lifecycle: 'running', // placeholder — assigned by lifecycleOf below
    };
    if (hasPriorityTag(s.metadata?.tags)) item.priority = true;
    const board = s.metadata?.board;
    if (board?.progress) item.progress = board.progress;
    if (board?.taskId) item.llmTaskId = board.taskId;
    item.llmAttention = llmAttentionOf(s);
    if (cls.status === 'attention') {
      if (sessionHasPendingRequests(s)) {
        const req = earliestRequest(s, lastActivityAt);
        item.attentionSince = req.at;
        if (req.tool) item.detail = { kind: 'tool', name: req.tool };
      } else {
        // LLM-flagged only: waiting since the verdict was produced.
        item.attentionSince = board?.analyzedAt ?? lastActivityAt;
      }
    }
    const lc = lifecycleOf(item);
    item.lifecycle = lc.lifecycle;
    if (lc.waitReason) item.waitReason = lc.waitReason;
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
    const termItem: BoardItem = {
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
      machineId: tm.machineId,
      lifecycle: 'running', // placeholder — assigned by lifecycleOf below
    };
    const lc = lifecycleOf(termItem);
    termItem.lifecycle = lc.lifecycle;
    if (lc.waitReason) termItem.waitReason = lc.waitReason;
    items.push(termItem);
  }

  // Total order (a consistent comparator — mixing per-group rules without a
  // primary key would make Array.sort unstable): status rank first, then
  // B-091 priority (the `priority` tag floats a session within its band —
  // deliberately NOT above the attention rank: a permission request stays on
  // top of the waiting column no matter what), then attention =
  // longest-waiting FIRST, others = most recent activity first.
  // Key tiebreak keeps the order stable across polls (no column jitter).
  const RANK: Record<BoardStatus, number> = { attention: 0, working: 1, idle: 2, ended: 3 };
  items.sort((a, b) => {
    const r = RANK[a.status] - RANK[b.status];
    if (r !== 0) return r;
    const p = (b.priority ? 1 : 0) - (a.priority ? 1 : 0);
    if (p !== 0) return p;
    const d =
      a.status === 'attention'
        ? (a.attentionSince ?? 0) - (b.attentionSince ?? 0)
        : b.lastActivityAt - a.lastActivityAt;
    return d !== 0 ? d : a.key.localeCompare(b.key);
  });
  return items;
}

//
// Lifecycle columns + completion records (the default view).
//

export interface LifecycleColumns {
  running: BoardItem[];
  waiting: BoardItem[];
}

/**
 * Split already-sorted board items into the lifecycle columns. Filters ONLY —
 * no re-sort: buildBoardItems' total order (attention longest-wait first →
 * working → idle newest-first → ended newest-first) already yields exactly
 * the wanted waiting order: urgent band (permission/needsInput/review/blocked,
 * longest-waiting on top) followed by the reap band (idle/ended, most recent
 * first). One sort rule across every layout, not two.
 */
export function buildLifecycleColumns(items: BoardItem[]): LifecycleColumns {
  return {
    running: items.filter((i) => i.lifecycle === 'running'),
    waiting: items.filter((i) => i.lifecycle === 'waiting'),
  };
}

/** A row in the Done column — a lightweight completion record, not a live
 *  board item. Sessions come from `metadata.completedAt` (stamped by the ✓
 *  action before the archive), tasks from BoardTask status==='done'. */
export interface CompletedEntry {
  key: string; // `done:s:<sessionId>` / `done:task:<taskId>`
  kind: 'session' | 'task';
  title: string;
  /** completion moment (drives the window + newest-first order) */
  at: number;
  /** session records open the archived session; task records aren't links */
  href?: string;
}

/** completion records older than this fall off (same 24h horizon as ended
 *  items — the board shows operations in flight plus today's harvest; older
 *  history lives in the sidebar's archived filter / the KV task list) */
export const DONE_WINDOW_MS = ENDED_WINDOW_MS;

export function buildCompletedEntries(
  sessions: Session[],
  tasks: BoardTask[],
  now: number,
): CompletedEntry[] {
  const entries: CompletedEntry[] = [];
  for (const s of sessions) {
    if (isHiddenSession(s)) continue; // B-053/B-105
    const at = s.metadata?.completedAt;
    if (!at || now - at > DONE_WINDOW_MS) continue;
    entries.push({
      key: `done:s:${s.id}`,
      kind: 'session',
      title: s.metadata?.summary?.text ?? '',
      at,
      href: `/session/${s.id}`,
    });
  }
  for (const t of tasks) {
    if (t.status !== 'done') continue;
    const at = t.updatedAt ?? t.createdAt;
    if (now - at > DONE_WINDOW_MS) continue;
    entries.push({ key: `done:task:${t.id}`, kind: 'task', title: t.title, at });
  }
  entries.sort((a, b) => (b.at - a.at !== 0 ? b.at - a.at : a.key.localeCompare(b.key)));
  return entries;
}

//
// V2: swimlane grouping — board items regrouped by board task.
//

export interface BoardLane {
  task: BoardTask;
  items: BoardItem[];
}

export interface BoardLanes {
  lanes: BoardLane[];
  /** everything not claimed by a task: terminals + unclassified sessions */
  ungrouped: BoardItem[];
}

/**
 * Group already-sorted board items into per-task swimlanes.
 *
 * Membership, in priority order:
 *  1. manual dispatch mapping (task.sessionIds) — a session dispatched from a
 *     task card belongs to that task, full stop;
 *  2. the LLM's metadata.board.taskId — fallback ONLY for sessions no task
 *     claims manually (the model classifies, the human overrides).
 * Terminals never map to tasks (V2.5) and always land in ungrouped. A session
 * manually claimed by several tasks (double dispatch) goes to the first by
 * lane order. Items keep their buildBoardItems order inside a lane, so each
 * lane reads attention → working → idle/ended exactly like the status view —
 * one sort rule across both layouts, not two.
 *
 * Lanes: open tasks only (a 'done'/'deleted' task's sessions fall back to
 * ungrouped), in board order (compareTaskOrder: fractional `order` keys first,
 * legacy unkeyed tasks after them newest-first). Empty lanes are kept — a
 * freshly created task with nothing dispatched yet must be visible to
 * dispatch onto.
 */
export function groupBoardItems(items: BoardItem[], tasks: BoardTask[]): BoardLanes {
  const lanes: BoardLane[] = tasks
    .filter((t) => t.status === 'open')
    .sort(compareTaskOrder)
    .map((task) => ({ task, items: [] }));

  const manualLaneBySession = new Map<string, BoardLane>();
  const laneByTaskId = new Map<string, BoardLane>();
  for (const lane of lanes) {
    laneByTaskId.set(lane.task.id, lane);
    for (const sid of lane.task.sessionIds ?? []) {
      if (!manualLaneBySession.has(sid)) manualLaneBySession.set(sid, lane);
    }
  }

  const ungrouped: BoardItem[] = [];
  for (const item of items) {
    if (item.kind !== 'session') {
      ungrouped.push(item);
      continue;
    }
    const lane =
      manualLaneBySession.get(item.key) ??
      (item.llmTaskId ? laneByTaskId.get(item.llmTaskId) : undefined);
    if (lane) lane.items.push(item);
    else ungrouped.push(item);
  }
  return { lanes, ungrouped };
}
