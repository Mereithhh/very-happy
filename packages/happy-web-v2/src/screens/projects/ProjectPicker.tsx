import { ChevronDown, CircleSlash, FolderKanban, FolderPlus } from 'lucide-react';
import type { ProjectView } from '@slopus/happy-wire';
import { ActionDropdownMenu, type MenuItemDef } from '@/ui/Menu';
import { useTranslation } from '@/i18n/useTranslation';
import { pickerLabel, type ProjectChoice } from './projectChoice';
import '@/screens/sessions/newsession.css';
import './projects.css';

/**
 * B-726: the one project picker (new team, new session, 移到项目, team
 * settings). A design-system menu with a check column, never a native
 * `<select>`. `newName` turns on the「新建同名项目」option (team creation /
 * old-team one-click); without it the choices are existing projects and
 * 「无项目」.
 */
export function ProjectPicker({ id, value, onChange, projects, newName, noneLabel, disabled }: {
  id?: string;
  value: ProjectChoice;
  onChange: (next: ProjectChoice) => void;
  projects: ProjectView[];
  /** Name the new project would get; present ⇒ offer「新建同名项目」. */
  newName?: string;
  /** Overrides「无项目」(e.g.「不放进项目」for a team). */
  noneLabel?: string;
  disabled?: boolean;
}) {
  const zh = useTranslation().lang.startsWith('zh');
  const live = projects.filter((p) => !p.archivedAt);
  const none = noneLabel ?? (zh ? '无项目' : 'No project');
  const items: MenuItemDef[] = [
    ...(newName !== undefined ? [{
      key: 'new', icon: FolderPlus, checked: value.kind === 'new',
      label: zh ? `新建同名项目${newName.trim() ? `「${newName.trim()}」` : ''}` : `New project${newName.trim() ? ` "${newName.trim()}"` : ' with the same name'}`,
      onSelect: () => onChange({ kind: 'new' }),
    }] : []),
    ...live.map((p, i) => ({
      key: `p:${p.id}`, icon: FolderKanban, label: p.name, checked: value.kind === 'existing' && value.projectId === p.id,
      separatorBefore: i === 0 && newName !== undefined,
      onSelect: () => onChange({ kind: 'existing', projectId: p.id }),
    })),
    { key: 'none', icon: CircleSlash, label: none, checked: value.kind === 'none', separatorBefore: true, onSelect: () => onChange({ kind: 'none' }) },
  ];
  const label = pickerLabel(value, live, { zh, newName, none });
  return (
    <ActionDropdownMenu items={items} align="start" matchTriggerWidth contentClassName="vh-project-picker-menu">
      <button type="button" id={id} className="ns-select vh-project-picker" disabled={disabled} aria-haspopup="menu">
        {value.kind === 'new' ? <FolderPlus size={15} aria-hidden /> : value.kind === 'none' ? <CircleSlash size={15} aria-hidden /> : <FolderKanban size={15} aria-hidden />}
        <span>{label}</span>
        <ChevronDown size={15} aria-hidden className="vh-project-picker-chev" />
      </button>
    </ActionDropdownMenu>
  );
}
