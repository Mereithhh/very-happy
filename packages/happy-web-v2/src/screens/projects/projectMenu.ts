import { Archive, ArchiveRestore, MessageSquarePlus, Pencil, Settings2 } from 'lucide-react';
import type { ProjectView } from '@slopus/happy-wire';
import type { MenuItemDef } from '@/ui';

/**
 * B-756: a project's actions as data — the sidebar project group head
 * (right-click / long-press), the tag lens's project entry and the /projects
 * list rows all use this one list.
 */
export function projectPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}`;
}

/** Project settings (B-757 owns the page; this is the one place that names its route). */
export function projectSettingsPath(projectId: string): string {
  return `${projectPath(projectId)}/settings`;
}

/** Where 「新建会话」 lands: the project's primary folder (else the first one), or null when it has none. */
export function projectPrimaryFolder(project: Pick<ProjectView, 'folders'>): { machineId: string; path: string } | null {
  const f = project.folders.find((x) => x.primary) ?? project.folders[0];
  return f ? { machineId: f.machineId, path: f.path } : null;
}

export function projectMenuCopy(zh: boolean) {
  return zh
    ? { newSession: '新建会话', settings: '项目设置', rename: '重命名', archive: '归档项目', unarchive: '取消归档', actions: '项目操作' }
    : { newSession: 'New session', settings: 'Project settings', rename: 'Rename', archive: 'Archive project', unarchive: 'Unarchive', actions: 'Project actions' };
}

export function buildProjectMenu(input: {
  zh: boolean;
  archived?: boolean;
  onNewSession: () => void;
  onSettings: () => void;
  onRename: () => void;
  onArchive: () => void;
}): MenuItemDef[] {
  const c = projectMenuCopy(input.zh);
  return [
    { key: 'new-session', label: c.newSession, icon: MessageSquarePlus, disabled: input.archived, onSelect: input.onNewSession },
    { key: 'settings', label: c.settings, icon: Settings2, onSelect: input.onSettings },
    { key: 'rename', label: c.rename, icon: Pencil, onSelect: input.onRename },
    { key: 'archive', label: input.archived ? c.unarchive : c.archive, icon: input.archived ? ArchiveRestore : Archive, danger: !input.archived, separatorBefore: true, onSelect: input.onArchive },
  ];
}
