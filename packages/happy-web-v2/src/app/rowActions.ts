/**
 * rowActions — the archive / close / rename flows for a conversation row,
 * shared by every surface that shows one (sidebar rows, board cards). Each
 * flow owns its confirm dialog and the ordering quirks that were battle-won
 * in the sidebar; extracting them means the board can't re-learn those bugs.
 *
 * Archive-only (B-083): the web deliberately has NO "delete" concept anymore.
 * Chat sessions end by archiving (every message/record survives server-side);
 * terminals end by closing (tmux dies, the claude conversation inside stays
 * on the machine, resumable via `claude --resume`).
 *
 * Imperative modules only (Modal, storage.getState, plain `t`) — safe to call
 * from event handlers in any component.
 */
import { t } from '@/i18n/useTranslation';
import { Modal } from '@/modal';
import { getCurrentAuth } from '@/auth/AuthContext';
import { notifyWebhook } from '@/sync/apiWebhook';
import { sessionUpdateTitleTags, sessionArchive, sessionMarkCompleted, machineForgetTerminal, machineKillTerminal, machineRestoreTerminal } from '@/sync/ops';
import type { NavigateFunction } from 'react-router-dom';
import { createTerminalAt } from './newTerminal';
import type { ClosedTerminalRow } from '@/sync/closedTerminals';
import { isMachineOnline, machineLabel } from '@/utils/machineUtils';
import { storage } from '@/sync/storage';
import { useTerminalSessions } from '@/sync/terminalSessions';
import type { Session } from '@/sync/storageTypes';
import { nextPathAfterClose } from './nextSession';
import { sessionPlacementResolver } from './sessionPlacement';
import { projectsSnapshot } from '@/sync/projects';
import { teamNavigationSnapshot } from '@/screens/sessions/useTeamNavigation';
import { projectPath } from '@/screens/projects/projectMenu';
import { commitSessionArchive } from './sessionArchiveFlow';
import { restoreSession, useSessionRestore } from './sessionRestore';
import { archiveCommitKey, deferredCommits, installDeferredCommitFlush, isPageExitFlush, isUnloadFlush, type FlushReason } from './deferredCommit';
import { holdSessionInactive } from '@/sync/sessionArchiveHold';
import { toast } from '@/ui/Toast';

/** B-566: how long mark-done can be undone before the server call. */
export const UNDO_WINDOW_MS = 6_000;
/** the inactive hold must outlive the window (+ the usual 5 s after commit),
 *  or a CLI heartbeat inside the window would resurrect the hidden row */
const UNDO_HOLD_MS = UNDO_WINDOW_MS + 5_000;

/** B-111: route to land on after closing `closedId` — the most recently
 *  active other visible session in the same place (B-774: its team page for a
 *  team conversation, the same project, or the no-project pool), else that
 *  project's page or '/'. Read the stores at CALL time (after the archive
 *  flipped local state is fine — the candidate set excludes the closed id
 *  explicitly). */
export function nextSessionPathAfterClose(closedId: string): string {
  const all = Object.values(storage.getState().sessions ?? {}) as Session[];
  const projects = projectsSnapshot();
  const teams = teamNavigationSnapshot();
  const placementOf = projects.status === 'ready' ? sessionPlacementResolver(projects.projects, projects.members, teams) : null;
  return nextPathAfterClose(all, closedId, {
    placementOf,
    teamHref: (teamId) => `/teams/${encodeURIComponent(teamId)}`,
    projectHref: projectPath,
  });
}

/** The server-owned archive transition (no confirm). The server commits the
 *  durable state first and then tells the daemon/session process to stop. */
export async function archiveSessionNow(session: Session, opts?: { keepalive?: boolean }): Promise<void> {
  const wasActive = session.active;
  const previousArchivedAt = session.archivedAt;
  if (wasActive) storage.getState().setSessionActiveLocal(session.id, false);
  // B-265: stamp the archive intent locally so the row reads "archived" (not
  // "offline") before the server's update-session round-trips.
  storage.getState().setSessionArchivedAtLocal(session.id, Date.now());
  try {
    await commitSessionArchive(() => sessionArchive(session.id, opts));
  } catch (error) {
    if (wasActive) storage.getState().setSessionActiveLocal(session.id, true);
    storage.getState().setSessionArchivedAtLocal(session.id, previousArchivedAt ?? null);
    throw error;
  }
}

/** B-265: restore an archived session in place (row button / menu / palette).
 *  The banner narrates progress on the detail screen; surfaces without one
 *  get the failure reason as an alert. Returns whether the daemon accepted. */
export async function restoreSessionOrAlert(sessionId: string): Promise<boolean> {
  const ok = await restoreSession(sessionId);
  if (ok) return true;
  const state = useSessionRestore.getState().states[sessionId];
  if (state?.phase === 'failed') {
    const detail = state.reason === 'unknown' && state.message ? ` (${state.message})` : '';
    Modal.alert(t('restore.failed'), `${t(`restore.reason.${state.reason ?? 'unknown'}`)}${detail}`);
  }
  return false;
}

/** B-265: restore a closed terminal in place through the daemon, then open
 *  it (attach path — the tmux session exists again). Unsupported daemon →
 *  the B-149 "new terminal in this cwd (+ claude --resume)" fallback; other
 *  failures are surfaced. Returns whether a terminal was opened. */
export async function restoreClosedTerminal(navigate: NavigateFunction, row: ClosedTerminalRow): Promise<boolean> {
  const result = await machineRestoreTerminal(row.machineId, row.terminalId);
  if (result.ok) {
    const machine = storage.getState().machines[row.machineId];
    useTerminalSessions.getState().adopt(row.terminalId, row.machineId, machine ? machineLabel(machine) : row.machineName, {
      title: row.title,
      tags: row.tags,
    });
    navigate(`/terminal/${encodeURIComponent(row.machineId)}?tid=${encodeURIComponent(row.terminalId)}`);
    return true;
  }
  if (result.reason === 'unsupported') {
    return createTerminalAt(navigate, row.machineId, { cwd: row.cwd, resumeClaudeSessionId: row.claudeSessionId });
  }
  const key = result.reason === 'no-record' ? 'restore.terminalNoRecord'
    : result.reason === 'missing-cwd' ? 'restore.reason.missing-cwd'
    : result.reason === 'tmux-session-gone' ? 'restore.reason.tmux-session-gone'
    : 'restore.terminalFailed';
  Modal.alert(t('restore.failed'), `${t(key as Parameters<typeof t>[0])}${result.message ? ` (${result.message})` : ''}`);
  return false;
}

/**
 * B-566: mark-done with an undo window instead of a confirm dialog (archive
 * went back to a confirm dialog in B-591; the machinery stays kind-generic).
 *
 * The row is hidden locally at once (inactive + archivedAt stamp, held
 * against heartbeats for the whole window); the server call waits
 * UNDO_WINDOW_MS. Undo reverts locally — nothing was sent, so other devices
 * never saw a change. Leaving the page commits immediately (see
 * deferredCommit). Delay-then-commit was chosen over commit-then-restore:
 * archive kills the process, and restore is a fresh spawn that fails when the
 * machine is offline (spec 2026-10-web-robustness-undo-presence).
 *
 * Returns true once the row is hidden (callers navigate away as before).
 */
function scheduleUndoableArchive(
  session: Session,
  kind: 'archive' | 'done',
  commit: (reason: FlushReason) => Promise<void>,
): boolean {
  const key = archiveCommitKey(session.id);
  if (deferredCommits.isPending(key)) return true;
  const state = storage.getState();
  const wasActive = session.active;
  const previousArchivedAt = session.archivedAt ?? null;
  if (wasActive) state.setSessionActiveLocal(session.id, false);
  holdSessionInactive(session.id, Date.now(), UNDO_HOLD_MS);
  state.setSessionArchivedAtLocal(session.id, Date.now());
  installDeferredCommitFlush();
  const handle = deferredCommits.schedule(key, {
    delayMs: UNDO_WINDOW_MS,
    commit: (reason) => commit(reason),
    revert: () => {
      const s = storage.getState();
      if (wasActive) s.setSessionActiveLocal(session.id, true);
      s.setSessionArchivedAtLocal(session.id, previousArchivedAt);
    },
  });
  toast.undoable(
    t(kind === 'done' ? 'robustness.markedDone' : 'robustness.archived'),
    t('robustness.undo'),
    () => {
      // already reverted elsewhere (restore / send on the session) → nothing to say
      if (!handle.undo() && handle.state() === 'committed') toast.show(t('robustness.undoTooLate'));
    },
    UNDO_WINDOW_MS,
  );
  return true;
}

/** Mark done with an undo window (board ✓). Undo = no completion record,
 *  no kill, no webhook. */
export function markSessionDoneWithUndo(session: Session, opts?: { notify?: boolean }): boolean {
  return scheduleUndoableArchive(session, 'done', async (reason) => {
    try {
      await markSessionDone(session, { ...opts, keepalive: isUnloadFlush(reason) });
    } catch (error) {
      reportCommitFailure('[markSessionDone] archive failed', error, reason);
    }
  });
}

/** B-566 review: a hidden tab is still alive — a failed commit there must
 *  still explain itself (the row is already back). Only a real teardown
 *  (pagehide) has nobody left to tell. */
function reportCommitFailure(tag: string, error: unknown, reason: FlushReason): void {
  console.error(tag, error);
  if (isPageExitFlush(reason)) return;
  const detail = error instanceof Error && error.message ? ` (${error.message})` : '';
  Modal.alert(t('common.error'), `${t('sessionInfo.failedToArchiveSession')}${detail}`);
}

/** Archive a chat session, confirm first (sidebar/menu/⌘W/board entry point).
 *  B-591: B-566 had replaced this dialog with an undo toast; the Owner found
 *  that too easy to trigger by accident (⌘W especially) — archive asks again,
 *  and only mark-done (one-click by Owner rule) keeps the undo window.
 *  Returns whether the archive actually ran — false means the user cancelled
 *  (callers like the ⌘W flow restore focus / stay put on cancel). */
export async function confirmArchiveSession(session: Session): Promise<boolean> {
  const ok = await Modal.confirm(t('sidebar.archiveConfirm'), undefined, {
    confirmText: t('common.archive'),
    destructive: true,
  });
  if (!ok) return false;
  try {
    await archiveSessionNow(session);
    return true;
  } catch (error) {
    console.error('[archiveSession] archive failed', error);
    const detail = error instanceof Error && error.message ? ` (${error.message})` : '';
    Modal.alert(t('common.error'), `${t('sessionInfo.failedToArchiveSession')}${detail}`);
    return false;
  }
}

/**
 * Mark a session DONE — the board's one-click completion (✓). Deliberately
 * NO confirm dialog: "标记完成必须一次点击" is an Owner-set boundary.
 *
 * Three steps, weakest-first:
 *  1. completion record: stamp `metadata.completedAt` (best-effort — the
 *     record must not block the completion; failures only warn). Written
 *     BEFORE the kill so the CLI's exit-time archive stamp rebases on top of
 *     it instead of racing it.
 *  2. kill-first archive (the completion itself — this one may throw).
 *  3. webhook notification `✅ 已完成 · <title>` via the server's
 *     /v1/webhook/notify (best-effort by contract; `notify: false` skips it —
 *     task-level batch completion sends ONE task notification instead).
 */
export async function markSessionDone(
  session: Session,
  opts?: { notify?: boolean; keepalive?: boolean },
): Promise<void> {
  if (opts?.keepalive) {
    // B-566: the page may be going away — nothing after an `await` is
    // guaranteed to run. Issue all three side effects NOW, in this task:
    // archive + webhook as keepalive fetches, the completion record over the
    // socket (no HTTP route exists for metadata writes, so it stays
    // best-effort; its write rebases on a version conflict, order not fatal).
    void sessionMarkCompleted(session.id).catch((error) => console.warn('[markSessionDone] completion record write failed', error));
    sendDoneWebhook(session, opts, true);
    await archiveSessionNow(session, { keepalive: true });
    return;
  } else {
    try {
      await sessionMarkCompleted(session.id);
    } catch (error) {
      console.warn('[markSessionDone] completion record write failed', error);
    }
  }
  await archiveSessionNow(session);
  sendDoneWebhook(session, opts, false);
}

function sendDoneWebhook(session: Session, opts: { notify?: boolean } | undefined, keepalive: boolean): void {
  if (opts?.notify === false) return;
  const title = session.metadata?.summary?.text?.trim() || t('session.newChat');
  const credentials = getCurrentAuth()?.credentials;
  if (credentials) {
    void notifyWebhook(credentials, {
      title: `✅ 已完成 · ${title}`,
      sessionId: session.id,
    }, keepalive ? { keepalive: true } : undefined);
  }
}

/** Close a web terminal (confirm first): ends its tmux session on the
 *  machine (resources ARE released — that part is real); the daemon's next
 *  push confirms the close by absence, and the optimistic overlay hides the
 *  row meanwhile. The claude conversation that ran inside survives on the
 *  machine (`~/.claude` JSONL) and can be continued with `claude --resume` —
 *  hence the neutral, non-scary wording (B-083).
 *
 *  `onConfirmed` runs BEFORE the kill and must navigate away when the closed
 *  terminal is the open one: a still-mounted terminal screen re-opens the id
 *  on its next catch-up (and a refresh on its URL re-mounts it), which used to
 *  recreate the killed tmux session — the "terminal won't delete" bug.
 *
 *  A failed kill (machine offline / RPC error) is surfaced, not swallowed:
 *  hiding the row anyway would be a lie the machine's push immediately undoes.
 *
 *  Returns whether the user confirmed (false = cancelled; a confirmed-but-
 *  failed kill still returns true — the failure is surfaced via the alert). */
export async function confirmCloseTerminal(
  machineId: string,
  terminalId: string,
  onConfirmed?: () => void,
): Promise<boolean> {
  // B-282: an ATTACHED terminal's close only disconnects — the user's tmux
  // session (and everything running in it) stays alive on the machine. Say
  // so instead of the generic "process ends now" text. Derived here so every
  // caller (sidebar, board, ⌘W) gets the honest wording for free.
  // B-474: the machine is gone — `kill-terminal` has nobody to answer it, and
  // before this the user waited for the RPC to time out and then got an error
  // with the row still there. Offer what IS possible: take the row off the
  // stored list, saying plainly that nothing is being terminated and that a
  // machine which comes back with the session alive brings the row back.
  const machine = storage.getState().machines[machineId];
  if (machine && !isMachineOnline(machine)) {
    const removed = await Modal.confirm(
      t('terminal.offlineCloseTitle'),
      t('terminal.offlineCloseMessage', { machine: machineLabel(machine) }),
      { confirmText: t('terminal.offlineCloseConfirm'), destructive: true },
    );
    if (!removed) return false;
    onConfirmed?.();
    await forgetTerminalNow(machineId, terminalId);
    return true;
  }
  const attachName = useTerminalSessions.getState().terminals.find((tm) => tm.id === terminalId)?.attachTmux;
  const ok = attachName
    ? await Modal.confirm(t('terminal.closeAttachedTitle'), t('terminal.closeAttachedMessage', { name: attachName }), {
        confirmText: t('terminal.closeAttachedConfirm'),
      })
    : await Modal.confirm(t('terminal.closeTitle'), t('terminal.closeMessage'), {
        confirmText: t('common.close'),
      });
  if (!ok) return false;
  await closeTerminalNow(machineId, terminalId, onConfirmed);
  return true;
}

/** B-282: destructive variant for attach terminals — kills the web terminal
 *  AND the user tmux session it is attached to. Callers gate the entry on
 *  `killAttachedSupported(daemonState)`. */
export async function confirmKillAttachedTerminal(
  machineId: string,
  terminalId: string,
  attachName: string,
  onConfirmed?: () => void,
): Promise<boolean> {
  const ok = await Modal.confirm(
    t('terminal.killAttachedTitle'),
    t('terminal.killAttachedMessage', { name: attachName }),
    { confirmText: t('terminal.killAttachedConfirm'), destructive: true },
  );
  if (!ok) return false;
  await closeTerminalNow(machineId, terminalId, onConfirmed, { alsoAttached: true });
  return true;
}

/** B-474: take a terminal off an offline machine's stored list (no kill — see
 *  machineForgetTerminal). The row goes locally too, and the machine's push
 *  record is rewritten with the same list so the 30 s remove-overlay expiring
 *  cannot bring it back. */
export async function forgetTerminalNow(machineId: string, terminalId: string): Promise<void> {
  const result = await machineForgetTerminal(machineId, terminalId);
  if (!result.ok) {
    Modal.alert(t('common.error'), `${t('terminal.offlineCloseFailed')}${result.message ? ` (${result.message})` : ''}`);
    return;
  }
  const machine = storage.getState().machines[machineId];
  useTerminalSessions.getState().remove(terminalId);
  useTerminalSessions.getState().applyPush(
    machineId,
    machine ? machineLabel(machine) : machineId.slice(0, 8),
    result.terminals,
    Date.now(),
  );
}

/** The close itself, no confirm (⌘W with `closeViewConfirm` off, and the tail
 *  of confirmCloseTerminal). `onBeforeKill` runs BEFORE the kill for the same
 *  navigate-away-first reason documented on confirmCloseTerminal. */
export async function closeTerminalNow(
  machineId: string,
  terminalId: string,
  onBeforeKill?: () => void,
  opts?: { alsoAttached?: boolean },
): Promise<void> {
  onBeforeKill?.();
  const killed = await machineKillTerminal(machineId, terminalId, opts);
  if (!killed) {
    Modal.alert(t('common.error'), t('sessionInfo.failedToKillSession'));
    return;
  }
  useTerminalSessions.getState().remove(terminalId);
}

/** Persist a rename dialog's result for a row (chat session or terminal).
 *  Only writes what actually changed: title and tags ride the same
 *  update-metadata round-trip; a no-op save must not bump the metadata
 *  version. Terminal fields persist independently in daemon-owned tmux state. */
export async function saveRowRename(
  target:
    | { kind: 'terminal'; terminalId: string; currentTitle: string; currentTags?: string[] }
    | { kind: 'session'; session: Session; currentTitle: string },
  title: string,
  tags?: string[],
): Promise<void> {
  if (target.kind === 'terminal') {
    const clean = title.trim();
    const changes: { title?: string; tags?: string[] } = {};
    if (clean && clean !== target.currentTitle) changes.title = clean;
    if (tags && target.currentTags !== undefined && JSON.stringify(tags) !== JSON.stringify(target.currentTags)) changes.tags = tags;
    useTerminalSessions.getState().update(target.terminalId, changes);
    return;
  }
  const s = target.session;
  const changes: { title?: string; tags?: string[] } = {};
  if (title.trim() !== target.currentTitle) changes.title = title;
  const curTags = s.metadata?.tags ?? [];
  if (tags && JSON.stringify(tags) !== JSON.stringify(curTags)) changes.tags = tags;
  if (changes.title !== undefined || changes.tags !== undefined) {
    await sessionUpdateTitleTags(s.id, changes).catch(() => {});
  }
}

/** Every tag currently in use across sessions (case-insensitive dedupe,
 *  first-seen casing wins), most-used first — rename-dialog suggestions. */
export function collectAllTags(
  sessions: Array<Session | string> | null,
  terminals: Array<{ tags?: string[] }> = [],
): string[] {
  const counts = new Map<string, { tag: string; n: number }>();
  for (const s of sessions ?? []) {
    if (typeof s === 'string') continue;
    for (const tag of s.metadata?.tags ?? []) {
      const k = tag.toLowerCase();
      const cur = counts.get(k);
      if (cur) cur.n++;
      else counts.set(k, { tag, n: 1 });
    }
  }
  for (const terminal of terminals) {
    for (const tag of terminal.tags ?? []) {
      const k = tag.toLowerCase();
      const cur = counts.get(k);
      if (cur) cur.n++;
      else counts.set(k, { tag, n: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.n - a.n).map((x) => x.tag);
}
