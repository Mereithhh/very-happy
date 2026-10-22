import { Archive, ArrowDown, ArrowUp, Flag, FolderKanban, FolderMinus, Link2, Pencil, RotateCcw, Square, Tags, Users, X } from 'lucide-react';
import type { MenuItemDef } from '@/ui';
import { PRIORITY_LEVELS, priorityTag, type PriorityLevel } from '@/utils/tags';

/**
 * B-756: ONE builder for a session's actions, shared by the sidebar row (⋯ and
 * right-click / long-press) and the session header ⋯. Each surface passes the
 * handlers it can honour; an absent handler hides its item, so both menus list
 * the same actions in the same order whenever the same capabilities apply.
 * Surface-only extras (the row's 预览 / reorder / worktree delete, the
 * header's panels / runtime / keep-awake) are added by the caller around it.
 *
 * Order: 分享… · 重命名 · 标签 · 移到项目 / 从项目移出 · 优先级 · 复制链接 · 恢复 ·
 * 上移/下移 · 停止 · 归档 (or 关闭 for a terminal).
 */
export type SessionMenuKey =
  | 'share' | 'rename' | 'tags' | 'move-project' | 'leave-project'
  | `priority-${PriorityLevel}` | 'copy-link' | 'restore' | 'move-up' | 'move-down' | 'stop' | 'archive';

type T = (key: any, params?: any) => string;

export interface SessionMenuInput {
  t: T;
  zh: boolean;
  isTerminal?: boolean;
  /** Opens the B-701 share panel (owner, active, non-mirror sessions only). */
  onShare?: () => void;
  onRename?: () => void;
  /** Tags live in the same rename dialog; a separate item makes them findable. */
  onTags?: () => void;
  /** From `sessionProjectMenu`: 「移到项目…」 / 「换项目…」 and 「从「X」移出」. */
  project?: { move: string | null; leave: { label: string } | null };
  onMoveToProject?: () => void;
  onLeaveProject?: () => void;
  priority?: { level: PriorityLevel | null; onSet: (level: PriorityLevel | null) => void };
  onCopyLink?: () => void;
  restore?: { onSelect: () => void; disabled?: boolean };
  reorder?: { canUp: boolean; canDown: boolean; onMove: (dir: -1 | 1) => void };
  /** Only while a turn is running (sessionAbort). */
  onStop?: () => void;
  onArchive?: () => void;
}

export function sessionMenuCopy(zh: boolean) {
  return zh
    ? { tags: '标签…', copyLink: '复制链接', stop: '停止' }
    : { tags: 'Tags…', copyLink: 'Copy link', stop: 'Stop' };
}

export function buildSessionMenu(input: SessionMenuInput): MenuItemDef[] {
  const { t } = input;
  const copy = sessionMenuCopy(input.zh);
  const items: MenuItemDef[] = [];
  if (input.onShare) items.push({ key: 'share', label: t('share.menu'), icon: Users, onSelect: input.onShare });
  if (input.onRename) items.push({ key: 'rename', label: t('common.rename'), icon: Pencil, onSelect: input.onRename });
  if (input.onTags) items.push({ key: 'tags', label: copy.tags, icon: Tags, onSelect: input.onTags });
  if (input.project?.move && input.onMoveToProject) items.push({ key: 'move-project', label: input.project.move, icon: FolderKanban, onSelect: input.onMoveToProject });
  if (input.project?.leave && input.onLeaveProject) items.push({ key: 'leave-project', label: input.project.leave.label, icon: FolderMinus, onSelect: input.onLeaveProject });
  if (input.priority) {
    // B-522: P0/P1/P2 as checkable items; the current one unchecks (clears).
    const { level: current, onSet } = input.priority;
    for (const level of PRIORITY_LEVELS) {
      items.push({
        key: `priority-${level}`,
        label: t('sidebar.markPriorityLevel', { level: priorityTag(level) }),
        icon: Flag,
        checked: current === level,
        separatorBefore: level === 0,
        onSelect: () => onSet(current === level ? null : level),
      });
    }
  }
  if (input.onCopyLink) items.push({ key: 'copy-link', label: copy.copyLink, icon: Link2, separatorBefore: !input.priority, onSelect: input.onCopyLink });
  if (input.restore) items.push({ key: 'restore', label: t('restore.restore'), icon: RotateCcw, disabled: input.restore.disabled, onSelect: input.restore.onSelect });
  if (input.reorder) {
    const { canUp, canDown, onMove } = input.reorder;
    items.push(
      { key: 'move-up', label: t('sidebar.moveUp'), icon: ArrowUp, disabled: !canUp, onSelect: () => onMove(-1) },
      { key: 'move-down', label: t('sidebar.moveDown'), icon: ArrowDown, disabled: !canDown, onSelect: () => onMove(1) },
    );
  }
  if (input.onStop) items.push({ key: 'stop', label: copy.stop, icon: Square, separatorBefore: true, onSelect: input.onStop });
  // Archive-only (B-083): a chat ends by archiving; a terminal by a neutral close.
  if (input.onArchive) {
    items.push({
      key: 'archive',
      label: input.isTerminal ? t('common.close') : t('common.archive'),
      icon: input.isTerminal ? X : Archive,
      danger: !input.isTerminal,
      separatorBefore: !input.onStop,
      onSelect: input.onArchive,
    });
  }
  return items;
}

/** Absolute link to a sidebar row (session or terminal href), for 「复制链接」. */
export function sessionLink(origin: string, href: string): string {
  return `${origin.replace(/\/$/, '')}${href.startsWith('/') ? href : `/${href}`}`;
}

/**
 * Which shared actions a chat session offers — the ONE gate both surfaces use,
 * so the sidebar row and the header ⋯ can't drift apart. A session shared WITH
 * me only offers 复制链接 (everything else writes the owner's session); an
 * archived one is restored, not re-archived or shared; 停止 only while a turn runs.
 */
export function sessionMenuAvailability(session: { archivedAt?: number | null; share?: unknown }, opts: { running: boolean; mirror: boolean }) {
  const owned = !session.share;
  const active = session.archivedAt == null;
  return {
    share: owned && active && !opts.mirror,
    rename: owned,
    tags: owned,
    priority: owned,
    copyLink: true,
    stop: owned && opts.running,
    archive: owned && active,
  };
}
