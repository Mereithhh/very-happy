/**
 * B-586 「归档并删除 worktree…」: the opt-in sibling of plain archive (which
 * never deletes anything). Order: inspect → confirm (destructive) → if the
 * worktree has user changes, a SECOND destructive confirm listing them →
 * archive immediately (no undo window: the deletion cannot be undone) →
 * `worktree-remove`. The branch is kept, so commits survive.
 */
import { Modal } from '@/modal';
import { storage } from '@/sync/storage';
import type { Session } from '@/sync/storageTypes';
import { worktreeInspect, worktreeRemove } from '@/sync/worktreeOps';
import { machineSupportsWorktrees } from '@/utils/worktree';
import { worktreeCopy } from '@/screens/sessions/worktreeCopy';
import { getCurrentLanguage } from '@/text';
import { toast } from '@/ui/Toast';
import { archiveSessionNow } from './rowActions';

/** The menu item shows only for a non-archived worktree session on a capable daemon. */
export function canArchiveAndDeleteWorktree(session: Session | undefined, machine: { metadata?: { worktreeVersion?: number } | null } | undefined): boolean {
    return !!session && session.archivedAt == null && !!session.metadata?.worktree && !!session.metadata.machineId && machineSupportsWorktrees(machine);
}

function worktreePathOf(session: Session): string {
    return session.metadata?.worktree?.root || session.metadata?.path || '';
}

/** Other live (non-archived) sessions working in the same directory. */
export function otherSessionsInWorktree(session: Session, all: Session[]): number {
    const root = worktreePathOf(session);
    return all.filter((s) => s.id !== session.id && s.archivedAt == null && s.metadata?.machineId === session.metadata?.machineId
        && (s.metadata?.worktree?.root === root || s.metadata?.path === root || (s.metadata?.path ?? '').startsWith(`${root}/`))).length;
}

/** Returns true when the session was archived (callers navigate away as for archive). */
export async function archiveAndDeleteWorktree(session: Session): Promise<boolean> {
    const copy = worktreeCopy(getCurrentLanguage());
    const machineId = session.metadata?.machineId;
    const path = worktreePathOf(session);
    if (!machineId || !path) return false;

    const inspected = await worktreeInspect(machineId, path);
    if (!inspected.ok) {
        Modal.alert(copy.inspectFailed, inspected.unsupported ? copy.unsupported : inspected.error);
        return false;
    }
    const info = inspected.data;
    if (!info.removable) {
        Modal.alert(copy.inspectFailed, copy.notRemovable[info.reason ?? ''] ?? info.reason ?? '');
        return false;
    }
    const others = otherSessionsInWorktree(session, Object.values(storage.getState().sessions ?? {}) as Session[]);
    const ok = await Modal.confirm(copy.confirmTitle, [copy.confirmBody(path, info.branch), others ? copy.otherSessions(others) : ''].filter(Boolean).join(' '), {
        confirmText: copy.confirmDelete, cancelText: copy.cancel, destructive: true,
    });
    if (!ok) return false;
    let discard = false;
    if (info.dirtyCount > 0) {
        // The confirm body is plain text (newlines collapse): a comma list.
        const list = info.dirty.slice(0, 10).join(', ') + (info.dirtyCount > 10 ? ` … (+${info.dirtyCount - 10})` : '');
        discard = await Modal.confirm(copy.dirtyTitle, copy.dirtyBody(info.dirtyCount, list), {
            confirmText: copy.discardDelete, cancelText: copy.cancel, destructive: true,
        });
        if (!discard) return false;
    }

    try {
        await archiveSessionNow(session);
    } catch (error) {
        // Not archived → nothing is deleted either.
        Modal.alert(copy.removeFailed, error instanceof Error ? error.message : String(error));
        return false;
    }
    const removed = await worktreeRemove(machineId, path, discard);
    if (!removed.ok) {
        Modal.alert(copy.removeFailed, `${removed.error} (${path})`);
        return true;
    }
    toast.show(copy.removed);
    return true;
}
