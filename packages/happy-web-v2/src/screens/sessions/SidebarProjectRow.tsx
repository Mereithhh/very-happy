/**
 * B-756: a project entry in the tag lens's 「项目」 area. Same behaviour as a
 * project group head in the project lens: the name opens the project page, a
 * hover (always shown on touch) ＋ starts a session in it and ⚙ opens its
 * settings, right-click / long-press gives the shared project menu.
 */
import { FolderKanban, Plus, Settings2 } from 'lucide-react';
import { ActionContextMenu, type MenuItemDef } from '@/ui';
import { prefetchSessionDetail } from '@/app/prefetchSessionDetail';
import type { ProjectAreaEntry } from './sidebarProjectGroups';
import { projectMenuCopy } from '@/screens/projects/projectMenu';

export function SidebarProjectRow(props: {
  entry: ProjectAreaEntry;
  selected: boolean;
  zh: boolean;
  attentionLabel: string;
  menuItems: MenuItemDef[];
  creating?: boolean;
  onOpen: () => void;
  onNewSession: () => void;
  onSettings: () => void;
}) {
  const { entry, zh } = props;
  const c = projectMenuCopy(zh);
  const name = entry.project.name;
  const count = zh ? `${entry.sessions} 个会话` : `${entry.sessions} session${entry.sessions === 1 ? '' : 's'}`;
  return (
    <ActionContextMenu items={props.menuItems}>
      <div className={`sb-project-row${props.selected ? ' is-selected' : ''}`} data-project-id={entry.project.id}>
        <button type="button" className="sb-project-main" aria-current={props.selected ? 'page' : undefined} title={name} onClick={props.onOpen}>
          <FolderKanban size={16} aria-hidden />
          <span className="sb-project-name">{name}</span>
          {entry.attention > 0
            ? <span className="sb-section-attention" title={props.attentionLabel} aria-label={props.attentionLabel}>{entry.attention}</span>
            : <span className="sb-project-count mono" aria-label={count} title={count}>{entry.sessions}</span>}
        </button>
        <button type="button" className="sb-project-act" disabled={props.creating} title={`${c.newSession}：${name}`} aria-label={`${c.newSession}: ${name}`} onPointerDown={prefetchSessionDetail} onClick={props.onNewSession}><Plus size={14} /></button>
        <button type="button" className="sb-project-act" title={c.settings} aria-label={`${c.settings}: ${name}`} onClick={props.onSettings}><Settings2 size={14} /></button>
      </div>
    </ActionContextMenu>
  );
}
