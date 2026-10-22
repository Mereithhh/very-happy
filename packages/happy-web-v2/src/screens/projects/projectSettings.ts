import { PROJECT_LIMITS, type ProjectFolder, type ProjectMemberView, type ProjectView } from '@slopus/happy-wire';
import { normalizeWorkspacePath } from '@/screens/sessions/sidebarWorkspaceGroups';
import { isInsideTeamWorktree } from '@/utils/teamWorktree';

/**
 * B-757 project settings page (`/projects/:id/settings`): pure rules behind
 * its sections, so the page only renders and calls `projectsApi`.
 */

/** The settings page route; anchors (`#folders` …) jump to a section. */
export function projectSettingsPath(projectId: string, section?: ProjectSettingsSection): string {
  return `/projects/${encodeURIComponent(projectId)}/settings${section ? `#${section}` : ''}`;
}
export const PROJECT_SETTINGS_SECTIONS = ['basics', 'context', 'folders', 'teams', 'sessions', 'danger'] as const;
export type ProjectSettingsSection = typeof PROJECT_SETTINGS_SECTIONS[number];

/**
 * What the page lets you change. An archived project is read-only except for
 * 取消归档 and 删除 (the server only filters archived projects out of member
 * reads, so editing one would change a project nobody sees). A session that is
 * a member through a team (`via: team`) follows its team: it leaves by
 * unlinking the team, never one by one.
 */
export function projectSettingsPolicy(project: Pick<ProjectView, 'archivedAt'>) {
  const editable = project.archivedAt === null;
  return { editable, canArchive: editable, canUnarchive: !editable, canDelete: true };
}
export function canRemoveMember(member: Pick<ProjectMemberView, 'via'>, project: Pick<ProjectView, 'archivedAt'>): boolean {
  return member.via !== 'team' && projectSettingsPolicy(project).editable;
}

export type FolderDraft = { machineId: string; path: string };
export type FolderError = 'empty' | 'machine' | 'worktree' | 'duplicate' | 'limit';

/**
 * Why a folder can't be saved as entered, or null. `index` is the folder being
 * edited (it may keep its own path). Paths compare the way the server
 * normalizes them (trailing slashes dropped). A team member's worktree is never
 * a project folder (B-755): it would make unrelated sessions there 「加入项目」.
 */
export function folderError(folders: readonly ProjectFolder[], draft: FolderDraft, index?: number): FolderError | null {
  const path = normalizeWorkspacePath(draft.path.trim());
  if (!path) return 'empty';
  if (!draft.machineId) return 'machine';
  if (isInsideTeamWorktree(path)) return 'worktree';
  if (index === undefined && folders.length >= PROJECT_LIMITS.folders) return 'limit';
  const clash = folders.some((f, i) => i !== index && f.machineId === draft.machineId && normalizeWorkspacePath(f.path) === path);
  return clash ? 'duplicate' : null;
}

/** Add a folder; the first one becomes primary. */
export function addFolder(folders: readonly ProjectFolder[], draft: FolderDraft): ProjectFolder[] {
  return [...folders, { machineId: draft.machineId, path: draft.path.trim(), primary: folders.length === 0 }];
}
/** Edit one folder's machine/path in place; primary stays where it was. */
export function updateFolder(folders: readonly ProjectFolder[], index: number, draft: FolderDraft): ProjectFolder[] {
  return folders.map((f, i) => (i === index ? { ...f, machineId: draft.machineId, path: draft.path.trim() } : f));
}
/** Remove one folder; removing the primary hands primary to the first remaining one. */
export function removeFolder(folders: readonly ProjectFolder[], index: number): ProjectFolder[] {
  const rest = folders.filter((_, i) => i !== index);
  if (!folders[index]?.primary || rest.length === 0) return rest;
  return rest.map((f, i) => ({ ...f, primary: i === 0 }));
}
export function makePrimary(folders: readonly ProjectFolder[], index: number): ProjectFolder[] {
  return folders.map((f, i) => ({ ...f, primary: i === index }));
}

/** Basics form → PATCH body, or null when nothing changed / the name is empty. */
export function basicsPatch(project: Pick<ProjectView, 'name' | 'goal'>, name: string, goal: string): { name: string; goal: string | null } | null {
  const nextName = name.trim();
  const nextGoal = goal.trim() || null;
  if (!nextName) return null;
  if (nextName === project.name && nextGoal === (project.goal ?? null)) return null;
  return { name: nextName, goal: nextGoal };
}
