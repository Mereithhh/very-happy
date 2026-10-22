import { sessionAbort } from '@/sync/ops';
import { applyLocalMembership, projectsApi, refreshProjects } from '@/sync/projects';
import { toast } from '@/ui/Toast';
import { sessionLink } from './sessionMenu';

/**
 * B-756: the side effects behind the shared session menu (app/sessionMenu.ts),
 * so the sidebar row and the session header run the same flows.
 */
export async function copySessionLink(href: string, zh: boolean): Promise<void> {
  try {
    await navigator.clipboard.writeText(sessionLink(window.location.origin, href));
    toast.success(zh ? '链接已复制' : 'Link copied');
  } catch {
    toast.error(zh ? '无法写入剪贴板' : 'Could not copy the link');
  }
}

export async function stopSessionTurn(sessionId: string, failedCopy: string): Promise<void> {
  try {
    await sessionAbort(sessionId);
  } catch {
    toast.error(failedCopy);
  }
}

export async function leaveSessionProject(projectId: string, sessionId: string, zh: boolean): Promise<void> {
  try {
    await projectsApi.removeMember(projectId, sessionId);
    applyLocalMembership(null, [sessionId]);
  } catch {
    toast.error(zh ? '移出失败' : 'Could not remove');
  } finally {
    void refreshProjects();
  }
}
