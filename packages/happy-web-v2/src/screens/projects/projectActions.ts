import type { NavigateFunction } from 'react-router-dom';
import type { ProjectView } from '@slopus/happy-wire';
import type { RecentMachinePath } from '@/utils/quickChat';
import { createChatOrConfigure } from '@/app/newChat';
import { Modal } from '@/modal';
import { projectsApi, refreshProjects } from '@/sync/projects';
import { toast } from '@/ui/Toast';
import { buildProjectMenu, projectNewTeamPath, projectPath, projectPrimaryFolder, projectSettingsPath } from './projectMenu';

/**
 * B-756: the flows behind `buildProjectMenu`. Rename and archive go through the
 * same PATCH the project page uses; failures stay visible as a toast and the
 * shared snapshot is refreshed either way.
 */
export async function renameProject(project: Pick<ProjectView, 'id' | 'name'>, zh: boolean): Promise<void> {
  const name = (await Modal.prompt(zh ? '重命名项目' : 'Rename project', undefined, { defaultValue: project.name, confirmText: zh ? '保存' : 'Save' }))?.trim();
  if (!name || name === project.name) return;
  try {
    await projectsApi.update(project.id, { name: name.slice(0, 120) });
  } catch {
    toast.error(zh ? '重命名失败' : 'Could not rename the project');
  } finally {
    void refreshProjects();
  }
}

export async function toggleProjectArchived(project: Pick<ProjectView, 'id' | 'name' | 'archivedAt'>, zh: boolean): Promise<boolean> {
  const archiving = !project.archivedAt;
  if (archiving) {
    const ok = await Modal.confirm(
      zh ? `归档「${project.name}」？` : `Archive "${project.name}"?`,
      zh ? '项目会从侧栏收起；会话不受影响，随时可以在「项目」页取消归档。' : 'The project leaves the sidebar; its sessions are untouched. Unarchive it any time from the Projects page.',
      { confirmText: zh ? '归档' : 'Archive', destructive: true },
    );
    if (!ok) return false;
  }
  try {
    await projectsApi.update(project.id, { archived: archiving });
    return true;
  } catch {
    toast.error(zh ? '操作失败' : 'Something went wrong');
    return false;
  } finally {
    void refreshProjects();
  }
}

/** New session in the project's primary folder; with no folder yet the project page explains how to add one. */
export function newSessionInProject(project: ProjectView, navigate: NavigateFunction, openConfigure: (target?: RecentMachinePath) => void): void {
  const target = projectPrimaryFolder(project);
  if (!target) { navigate(projectPath(project.id)); return; }
  void createChatOrConfigure(navigate, openConfigure, { target, projectId: project.id });
}

export function projectMenuItems(project: ProjectView, opts: { zh: boolean; navigate: NavigateFunction; openConfigure: (target?: RecentMachinePath) => void; teams?: boolean }) {
  return buildProjectMenu({
    zh: opts.zh,
    archived: !!project.archivedAt,
    onNewSession: () => newSessionInProject(project, opts.navigate, opts.openConfigure),
    ...(opts.teams ? { onNewTeam: () => opts.navigate(projectNewTeamPath(project.id)) } : {}),
    onSettings: () => opts.navigate(projectSettingsPath(project.id)),
    onRename: () => void renameProject(project, opts.zh),
    onArchive: () => void toggleProjectArchived(project, opts.zh),
  });
}
