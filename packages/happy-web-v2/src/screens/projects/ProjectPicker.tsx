import { Plus } from 'lucide-react';
import './projects.css';
import type { ProjectView } from '@slopus/happy-wire';
import { Combobox } from '@/ui/Combobox';
import { useTranslation } from '@/i18n/useTranslation';
import { pickerLabel, type ProjectChoice } from './projectChoice';

const NEW = '__new__';
const NONE = '__none__';

/**
 * B-726: the one project picker (new team, new session, 移到项目, team
 * settings), on the B-714 `Combobox` (search past 8 projects, bottom sheet on
 * phones). `newName` adds the trailing action「＋ 新建同名项目」(team creation /
 * team settings); the other choices are existing projects and「无项目」.
 */
export function ProjectPicker({ id, value, onChange, projects, newName, noneLabel, disabled, label }: {
  id?: string;
  value: ProjectChoice;
  onChange: (next: ProjectChoice) => void;
  projects: ProjectView[];
  /** Name the new project would get; present ⇒ offer「新建同名项目」. */
  newName?: string;
  /** Overrides「无项目」(e.g.「不放进项目」for a team). */
  noneLabel?: string;
  disabled?: boolean;
  /** Accessible name of the control. */
  label?: string;
}) {
  const zh = useTranslation().lang.startsWith('zh');
  const live = projects.filter((p) => !p.archivedAt);
  const none = noneLabel ?? (zh ? '无项目' : 'No project');
  const options = [
    ...live.map((p) => ({ value: p.id, label: p.name })),
    { value: NONE, label: none },
  ];
  const selected = value.kind === 'existing' ? value.projectId : value.kind === 'none' ? NONE : NEW;
  const newLabel = pickerLabel({ kind: 'new' }, live, { zh, newName, none });
  return (
    <Combobox
      id={id}
      label={label ?? (zh ? '项目' : 'Project')}
      value={selected}
      options={options}
      disabled={disabled}
      size="md"
      className="vh-project-picker"
      renderValue={(option) => option?.label ?? (selected === NEW ? newLabel : pickerLabel(value, live, { zh, newName, none }))}
      onChange={(v) => onChange(v === NONE ? { kind: 'none' } : { kind: 'existing', projectId: v })}
      actions={newName !== undefined ? [{ key: 'new-project', label: newLabel, icon: Plus, onSelect: () => onChange({ kind: 'new' }) }] : undefined}
    />
  );
}
