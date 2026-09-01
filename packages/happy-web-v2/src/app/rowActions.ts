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
import { sessionUpdateTitleTags, sessionArchive, sessionMarkCompleted, machineKillTerminal, machineRestoreTerminal } from '@/sync/ops';
import type { NavigateFunction } from 'react-router-dom';
import { createTerminalAt } from './newTerminal';
import type { ClosedTerminalRow } from '@/sync/closedTerminals';
import { machineLabel } from '@/utils/machineUtils';
import { storage } from '@/sync/storage';
import { useTerminalSessions } from '@/sync/terminalSessions';
import type { Session } from '@/sync/storageTypes';
import { pickNextSessionId } from './nextSession';
import { commitSessionArchive } from './sessionArchiveFlow';
import { restoreSession, useSessionRestore } from './sessionRestore';

/** B-111: route to land on after closing `closedId` — the most recently
 *  active other visible session, or '/' when none is left. Read the store at
 *  CALL time (after the archive flipped local state is fine — the candidate
 *  set excludes the closed id explicitly). */
export function nextSessionPathAfterClose(closedId: string): string {
  const all = Object.values(storage.getState().sessions ?? {}) as Session[];
  const next = pickNextSessionId(all, closedId);
  return next ? `/session/${next}` : '/';
}

/** The server-owned archive transition (no confirm). The server commits the
 *  durable state first and then tells the daemon/session process to stop. */
export async function archiveSessionNow(session: Session): Promise<void> {
  const wasActive = session.active;
  const previousArchivedAt = session.archivedAt;
  if (wasActive) storage.getState().setSessionActiveLocal(session.id, false);
  // B-265: stamp the archive intent locally so the row reads "archived" (not
  // "offline") before the server's update-session round-trips.
  storage.getState().setSessionArchivedAtLocal(session.id, Date.now());
  try {
    await commitSessionArchive(() => sessionArchive(session.id));
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
    return createTerminalAt(navigate, row.machineId, row.cwd, row.claudeSessionId);
  }
  const key = result.reason === 'no-record' ? 'restore.terminalNoRecord'
    : result.reason === 'missing-cwd' ? 'restore.reason.missing-cwd'
    : 'restore.terminalFailed';
  Modal.alert(t('restore.failed'), `${t(key as Parameters<typeof t>[0])}${result.message ? ` (${result.message})` : ''}`);
  return false;
}

/** Archive a chat session, confirm first (sidebar/menu/⌘W entry point).
 *  Returns whether the archive actually ran — false means the user
 *  cancelled (callers like the ⌘W flow restore focus / stay put on cancel). */
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
    Modal.alert(t('common.error'), t('sessionInfo.failedToArchiveSession'));
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
  opts?: { notify?: boolean },
): Promise<void> {
  try {
    await sessionMarkCompleted(session.id);
  } catch (error) {
    console.warn('[markSessionDone] completion record write failed', error);
  }
  await archiveSessionNow(session);
  if (opts?.notify !== false) {
    const title = session.metadata?.summary?.text?.trim() || t('session.newChat');
    const credentials = getCurrentAuth()?.credentials;
    if (credentials) {
      void notifyWebhook(credentials, {
        title: `✅ 已完成 · ${title}`,
        sessionId: session.id,
      });
    }
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
  const ok = await Modal.confirm(t('terminal.closeTitle'), t('terminal.closeMessage'), {
    confirmText: t('common.close'),
  });
  if (!ok) return false;
  await closeTerminalNow(machineId, terminalId, onConfirmed);
  return true;
}

/** The close itself, no confirm (⌘W with `closeViewConfirm` off, and the tail
 *  of confirmCloseTerminal). `onBeforeKill` runs BEFORE the kill for the same
 *  navigate-away-first reason documented on confirmCloseTerminal. */
export async function closeTerminalNow(
  machineId: string,
  terminalId: string,
  onBeforeKill?: () => void,
): Promise<void> {
  onBeforeKill?.();
  const killed = await machineKillTerminal(machineId, terminalId);
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
