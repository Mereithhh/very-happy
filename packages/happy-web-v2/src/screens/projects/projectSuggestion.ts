import type { ProjectView } from '@slopus/happy-wire';
import { normalizeWorkspacePath } from '@/screens/sessions/sidebarWorkspaceGroups';

/**
 * B-649 directory rule (spec §1 归属规则 3): a session whose cwd lies inside a
 * project folder on the same machine is only SUGGESTED for that project —
 * never added automatically (Tanka / todo / automation spawns share repos).
 * The deepest matching folder wins; archived projects never suggest.
 */
export function suggestProjectFor(
  session: { machineId?: string | null; path?: string | null },
  projects: ProjectView[],
): ProjectView | null {
  const path = normalizeWorkspacePath(session.path ?? null);
  if (!session.machineId || !path) return null;
  let best: { project: ProjectView; depth: number } | null = null;
  for (const project of projects) {
    if (project.archivedAt) continue;
    for (const folder of project.folders) {
      if (folder.machineId !== session.machineId) continue;
      const root = normalizeWorkspacePath(folder.path);
      if (!root) continue;
      const inside = path === root || path.startsWith(root === '/' ? '/' : `${root}/`);
      if (inside && (!best || root.length > best.depth)) best = { project, depth: root.length };
    }
  }
  return best?.project ?? null;
}

const DISMISS_KEY = 'vh:project-suggestion-dismissed:v1';
/** Per-device dismissals (bounded); a dismissed session is never asked again here. */
export function readDismissed(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): Set<string> {
  try { return new Set(JSON.parse(storage?.getItem(DISMISS_KEY) ?? '[]') as string[]); } catch { return new Set(); }
}
export function writeDismissed(sessionId: string, storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.localStorage): void {
  try {
    const next = [...readDismissed(storage), sessionId].slice(-500);
    storage?.setItem(DISMISS_KEY, JSON.stringify(next));
  } catch { /* storage unavailable: the banner just returns next visit */ }
}
