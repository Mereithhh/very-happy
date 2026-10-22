import { useId, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { Checkbox } from '@/ui';
import { Combobox } from '@/ui/Combobox';
import { Segmented } from '@/ui/Segmented';
import { SuggestInput } from '@/ui/SuggestInput';
import { FsBrowser } from '@/screens/files/FsBrowser';
import { useAllMachines, useSetting } from '@/sync/storage';
import { isMachineOnline, machineLabel } from '@/utils/machineUtils';
import { withoutTeamWorktrees } from '@/utils/teamWorktree';
import { folderProblem, newFolderBlocker, type FolderProblem, type ProjectFolderDraft } from './projectFolderDraft';
import './projects.css';

export type { ProjectFolderDraft } from './projectFolderDraft';

export function folderPickerCopy(zh: boolean) {
  return zh ? {
    machine: '电脑', existing: '选择已有目录', create: '新建工作目录', path: '目录', browse: '浏览', gitInit: '初始化 git 仓库',
    newHint: '会在这台电脑的 home 下创建；已存在的目录请改用「选择已有目录」。',
    problem: { machine: '先选一台电脑', path: '先填目录', worktree: '这是团队成员的临时工作区，请选仓库目录', dotdot: '路径里不能有 ..', 'outside-home': '新目录只能建在 home 下面', 'new-offline': '电脑离线，暂时不能新建目录', 'new-unsupported': '这台电脑的 CLI 版本太旧，不能新建目录；请升级 CLI 或选择已有目录' } as Record<FolderProblem, string>,
  } : {
    machine: 'Computer', existing: 'Choose a folder', create: 'New working folder', path: 'Folder', browse: 'Browse', gitInit: 'Initialize a git repository',
    newHint: 'Created under this computer’s home; for a folder that already exists, use “Choose a folder”.',
    problem: { machine: 'Choose a computer first', path: 'Enter a folder first', worktree: 'This is a team member’s temporary worktree — choose the repository', dotdot: 'The path cannot contain ..', 'outside-home': 'A new folder must be inside home', 'new-offline': 'The computer is offline, so a folder cannot be created now', 'new-unsupported': 'This computer’s CLI is too old to create folders; update it or choose an existing folder' } as Record<FolderProblem, string>,
  };
}

/**
 * B-755: where a project lives — an existing folder on a computer, or a new
 * working folder the daemon creates (`fs-mkdir`, home-only). Remembered
 * folders never offer team worktrees. 「新建工作目录」 is disabled, with the
 * reason, when the computer is offline or its CLI predates `fs-mkdir`.
 * Shared by the new-project dialog and project settings.
 */
export function ProjectFolderPicker({ value, onChange, zh, showProblem = false }: { value: ProjectFolderDraft; onChange: (next: ProjectFolderDraft) => void; zh: boolean; showProblem?: boolean }) {
  const c = folderPickerCopy(zh);
  const ids = useId();
  const machines = useAllMachines({ includeOffline: true });
  const presets = useSetting('sessionPathPresets');
  const recents = useSetting('recentMachinePaths');
  const [browsing, setBrowsing] = useState(false);
  const machine = machines.find((m) => m.id === value.machineId);
  const online = !!machine && isMachineOnline(machine);
  const blocker = newFolderBlocker(machine, online);
  const problem = folderProblem(value, machine, online);
  const suggestions = [...new Set([
    ...(presets ?? []).map((p) => p.path),
    ...withoutTeamWorktrees(recents ?? []).filter((r) => r.machineId === value.machineId).map((r) => r.path),
  ])].filter((p) => !p.includes('/teams/worktrees/'));
  const set = (patch: Partial<ProjectFolderDraft>) => onChange({ ...value, ...patch });
  return (
    <div className="pj-folder-picker">
      <div className="pj-field">
        <span id={`${ids}-machine`}>{c.machine}</span>
        <Combobox size="md" labelledBy={`${ids}-machine`} label={c.machine} value={value.machineId || null} onChange={(machineId) => { setBrowsing(false); set({ machineId, ...(newFolderBlocker(machines.find((m) => m.id === machineId), !!machines.find((m) => m.id === machineId && isMachineOnline(m))) ? { mode: 'existing' as const } : {}) }); }}
          options={machines.map((m) => ({ value: m.id, label: machineLabel(m), meta: isMachineOnline(m) ? undefined : (zh ? '离线' : 'Offline') }))} />
      </div>
      <Segmented label={c.path} className="pj-folder-mode" value={value.mode} onChange={(mode) => { setBrowsing(false); set({ mode }); }}
        options={[{ value: 'existing', label: c.existing }, { value: 'new', label: c.create, disabled: !!blocker }]} />
      {value.mode === 'existing' ? (
        <>
          <div className="pj-folder-input">
            <SuggestInput className="ns-input" value={value.path} onValueChange={(path) => set({ path })} suggestions={suggestions} aria-label={c.path} placeholder="/home/me/code/repo" />
            <button type="button" className="pj-ghost" disabled={!online} onClick={() => setBrowsing((v) => !v)}><FolderOpen size={14} aria-hidden />{c.browse}</button>
          </div>
          {browsing && machine && <div className="pj-folder-browser"><FsBrowser machineId={machine.id} initialPath={value.path || machine.metadata?.homeDir || '/'} onPickDir={(path) => { set({ path }); setBrowsing(false); }} /></div>}
        </>
      ) : (
        <>
          <input className="ns-input pj-folder-new" value={value.path} onChange={(e) => set({ path: e.target.value })} aria-label={c.path} spellCheck={false} />
          <Checkbox checked={value.gitInit} onCheckedChange={(gitInit) => set({ gitInit })}>{c.gitInit}</Checkbox>
          <p className="pj-muted pj-folder-hint">{c.newHint}</p>
        </>
      )}
      {blocker && value.mode === 'existing' && machine && <p className="pj-muted pj-folder-hint">{c.problem[blocker]}</p>}
      {problem && (showProblem || problem === 'worktree' || problem === 'dotdot' || problem === 'outside-home') && <p className="pj-folder-problem" role="status">{c.problem[problem]}</p>}
    </div>
  );
}
