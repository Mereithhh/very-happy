/**
 * rowActions — the archive / delete / rename flows for a conversation row,
 * shared by every surface that shows one (sidebar rows, board cards). Each
 * flow owns its confirm dialog and the ordering quirks that were battle-won
 * in the sidebar; extracting them means the board can't re-learn those bugs.
 *
 * Imperative modules only (Modal, storage.getState, plain `t`) — safe to call
 * from event handlers in any component.
 */
import { t } from '@/i18n/useTranslation';
import { Modal } from '@/modal';
import { sessionUpdateTitleTags, sessionArchive, sessionKill, sessionDelete, machineKillTerminal } from '@/sync/ops';
import { storage } from '@/sync/storage';
import { useTerminalSessions } from '@/sync/terminalSessions';
import type { Session } from '@/sync/storageTypes';

/** Archive a chat session (confirm first). Mirrors happy-app's performArchive:
 *  server-side archive alone doesn't stick for a LIVE session — the running
 *  CLI keeps reporting itself active and flips the row back. So: optimistic
 *  local flip, then kill the CLI; only if it's already dead force-archive via
 *  the server. Rolls back on failure. */
export async function confirmArchiveSession(session: Session): Promise<void> {
  const ok = await Modal.confirm(t('sidebar.archiveConfirm'), undefined, {
    confirmText: t('common.archive'),
    destructive: true,
  });
  if (!ok) return;
  const wasActive = session.active;
  if (wasActive) storage.getState().setSessionActiveLocal(session.id, false);
  try {
    const killResult = await sessionKill(session.id);
    if (!killResult.success) {
      await sessionArchive(session.id);
    }
  } catch (error) {
    if (wasActive) storage.getState().setSessionActiveLocal(session.id, true);
    throw error;
  }
}

/** Permanently delete a session (confirm first). Best-effort kill while the
 *  CLI is still connected (the server rejects deleting a live session), then
 *  DELETE — sessionDelete purges the local copy and tombstones the id so the
 *  kill's straggler update can't resurrect the row. Returns true when the
 *  user confirmed (caller navigates away BEFORE calling when the session is
 *  the open one — pass `onConfirmed`). */
export async function confirmDeleteSession(
  session: Session,
  onConfirmed?: () => void,
): Promise<boolean> {
  const ok = await Modal.confirm(
    t('sessionInfo.deleteSessionConfirm'),
    t('sessionInfo.deleteSessionWarning'),
    { confirmText: t('common.delete'), destructive: true },
  );
  if (!ok) return false;
  onConfirmed?.();
  if (session.active || session.presence === 'online') {
    await sessionKill(session.id).catch(() => {});
  }
  const result = await sessionDelete(session.id);
  if (!result.success) {
    Modal.alert(t('common.error'), result.message || t('sessionInfo.failedToDeleteSession'));
  }
  return true;
}

/** Delete a web terminal (confirm first): kills its tmux session on the
 *  machine; the daemon's next push confirms the deletion by absence, and the
 *  optimistic overlay hides the row meanwhile.
 *
 *  `onConfirmed` runs BEFORE the kill and must navigate away when the deleted
 *  terminal is the open one: a still-mounted terminal screen re-opens the id
 *  on its next catch-up (and a refresh on its URL re-mounts it), which used to
 *  recreate the killed tmux session — the "terminal won't delete" bug.
 *
 *  A failed kill (machine offline / RPC error) is surfaced, not swallowed:
 *  hiding the row anyway would be a lie the machine's push immediately undoes. */
export async function confirmDeleteTerminal(
  machineId: string,
  terminalId: string,
  onConfirmed?: () => void,
): Promise<void> {
  const ok = await Modal.confirm(t('terminal.deleteTitle'), t('terminal.deleteMessage'), {
    confirmText: t('common.delete'),
    destructive: true,
  });
  if (!ok) return;
  onConfirmed?.();
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
 *  version. Terminals are title-only (tags need daemon-side tmux storage). */
export async function saveRowRename(
  target:
    | { kind: 'terminal'; terminalId: string; currentTitle: string }
    | { kind: 'session'; session: Session; currentTitle: string },
  title: string,
  tags?: string[],
): Promise<void> {
  if (target.kind === 'terminal') {
    const clean = title.trim();
    if (clean && clean !== target.currentTitle) {
      useTerminalSessions.getState().rename(target.terminalId, clean);
    }
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
export function collectAllTags(sessions: Array<Session | string> | null): string[] {
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
  return [...counts.values()].sort((a, b) => b.n - a.n).map((x) => x.tag);
}
