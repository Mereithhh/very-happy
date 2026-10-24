import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '@/i18n/useTranslation';
import { FolderOpen, ArrowUp, Bot, ChevronDown } from 'lucide-react';
import type { TeamProjectChoice, TeamState } from '@slopus/happy-wire';
import { z } from 'zod';
import { getServerUrl } from '@/sync/serverConfig';
import { TeamsApiError } from '@/sync/teams';
import { pendingIntentKey, readPendingIntent, retainPendingIntent, clearPendingIntent, canReplaceRejectedIntent } from './pendingIntent';
import { useAllMachines, useSetting, useProfile } from '@/sync/storage';
import { isMachineOnline, machineLabel } from '@/utils/machineUtils';
import { FsBrowser } from '@/screens/files/FsBrowser';
import { Checkbox } from '@/ui';
import { machineFsMkdir } from '@/sync/fsOps';
import { defaultNewFolder, folderProblem, newFolderBlocker } from '@/screens/projects/projectFolderDraft';
import { folderPickerCopy } from '@/screens/projects/ProjectFolderPicker';
import { useFirstUseCopy } from './firstUseCopy';
import { decideQuickChat } from '@/utils/quickChat';
import { recordRecentMachinePath } from '@/app/newChat';
import { Spinner } from '@/ui/Spinner';
import { Combobox } from '@/ui/Combobox';
import { SuggestInput } from '@/ui/SuggestInput';
import { t } from '@/text';
import { TeamHarnessModelFields } from './TeamHarnessModelFields';
import { preferredTeamAssistant } from './teamHarnessModel';
import { CollapsePanel } from '@/ui/CollapsePanel';
import { useProjects } from '@/sync/projects';
import { ProjectPicker } from '@/screens/projects/ProjectPicker';
import { teamProjectFromChoice, type ProjectChoice } from '@/screens/projects/projectChoice';
import { teamNameFromGoal } from './teamPresentation';
import { startBlocker } from './teamStartState';

export type TeamLaunchInput = { goal: string; directory: string; assistant: 'claude' | 'codex' | 'pi-acp'; model?: string };
export function supportsTeamLaunch(machine: { metadata?: unknown; active?: boolean; activeAt?: number }) {
  return (machine.metadata as { teamLaunchVersion?: number } | null)?.teamLaunchVersion === 1;
}
const intentSchema = z.object({ requestId: z.string().min(1), name: z.string().min(1), machineId: z.string().min(1), launch: z.object({ goal: z.string().min(1), directory: z.string().min(1), assistant: z.enum(['claude','codex','pi-acp']), model: z.string().optional() }), project: z.object({ projectId: z.string().optional(), create: z.boolean().optional() }).optional() });
type LaunchIntent = z.infer<typeof intentSchema>;
/**
 * `chooseProject` (B-726) shows「所属项目」— only when creating a new team; it
 * defaults to「新建同名项目」, or to `initialProjectId` when started from a
 * project page.
 */
export function TeamStartForm({ machineId: fixedMachine, intentScope = 'create', chooseProject = false, initialProjectId, onStart, onStarted }: { machineId?: string; intentScope?: string; chooseProject?: boolean; initialProjectId?: string; onStart: (name: string, machineId: string, launch: TeamLaunchInput, requestId: string, project?: TeamProjectChoice) => Promise<TeamState>; onStarted: (team: TeamState) => void }) {
  const c = useFirstUseCopy();
  const fieldId = useId();
  const { lang } = useTranslation(); const zh = lang.startsWith('zh');
  const profile = useProfile();
  const key = profile.id ? pendingIntentKey(getServerUrl(), profile.id, intentScope) : '';
  const mounted = useRef(true);
  const currentKey = useRef(key); currentKey.current = key;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [intent, setIntent] = useState<LaunchIntent | null>(null);
  const [restored, setRestored] = useState(false);
  const [goal, setGoal] = useState('');
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [assistant, setAssistant] = useState<TeamLaunchInput['assistant']>('claude');
  const machines = useAllMachines({ includeOffline: true });
  const presets = useSetting('sessionPathPresets');
  const recents = useSetting('recentMachinePaths');
  const defaultAgent = useSetting('newSessionAgent');
  const [configOpen, setConfigOpen] = useState(true);
  const [machineId, setMachine] = useState(fixedMachine ?? machines.find(m => isMachineOnline(m) && supportsTeamLaunch(m))?.id ?? machines[0]?.id ?? '');
  const [directory, setDirectory] = useState('');
  const [picking, setPicking] = useState(false);
  // B-755: 「新建工作目录」 — the daemon creates the folder (home-only) before the team starts there.
  const [newFolder, setNewFolder] = useState(false);
  const [gitInit, setGitInit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const projectsSnap = useProjects();
  const projectsReady = chooseProject && projectsSnap.status === 'ready';
  const initialChoice: ProjectChoice = initialProjectId ? { kind: 'existing', projectId: initialProjectId } : { kind: 'new' };
  const [projectChoice, setProjectChoice] = useState<ProjectChoice>(initialChoice);
  const goalRef = useRef<HTMLTextAreaElement>(null);
  const directoryRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setRestored(false); setBusy(false); setError(''); setPicking(false);
    setGoal(''); setName(''); setModel(''); setAssistant('claude'); setDirectory(''); setProjectChoice(initialChoice);
    setMachine(fixedMachine ?? '');
    if (!key) return;
    try {
      const saved = readPendingIntent(key, value => intentSchema.parse(value));
      setIntent(saved);
      if (saved) { setMachine(saved.machineId); setDirectory(saved.launch.directory); setGoal(saved.launch.goal); setName(saved.name); setModel(saved.launch.model ?? ''); setAssistant(saved.launch.assistant); setProjectChoice(saved.project?.projectId ? { kind: 'existing', projectId: saved.project.projectId } : saved.project?.create ? { kind: 'new' } : chooseProject ? { kind: 'none' } : initialChoice); }
      if (!saved) {
        const decision = decideQuickChat({machines: machines.filter(m => supportsTeamLaunch(m) && (!fixedMachine || m.id === fixedMachine)), recents: recents ?? [], alwaysAsk: false});
        // UI-P0-01: fold the configuration only when the computer AND the folder are both known (B-438: unknown → open).
        if (decision.kind === 'spawn' && decision.machineId && decision.directory) { setMachine(decision.machineId); setDirectory(decision.directory); setConfigOpen(false); }
        else setConfigOpen(true);
        setAssistant(defaultAgent === 'codex' ? 'codex' : defaultAgent === 'pi' || defaultAgent === 'pi-acp' ? 'pi-acp' : 'claude');
      }
      setRestored(true);
    } catch { setError(c.error); }
  }, [key]);
  useEffect(() => {
    if (!machineId && machines.length) setMachine(fixedMachine ?? machines.find(m => isMachineOnline(m) && supportsTeamLaunch(m))?.id ?? machines[0].id);
  }, [machineId, machines, fixedMachine]);
  const machine = machines.find(m => m.id === machineId);
  const ready = !!machine && isMachineOnline(machine) && supportsTeamLaunch(machine);
  const folderCopy = { ...folderPickerCopy(zh), existsTeam: zh ? '这个目录已经存在：取消勾选「新建工作目录」即可直接使用它。' : 'That folder already exists — untick “New working folder” to use it as is.', mkdirFailed: zh ? '新建目录失败' : 'Could not create the folder' };
  const newFolderBlocked = !!newFolderBlocker(machine, !!machine && isMachineOnline(machine));
  const folderProblemOf = (asNew: boolean) => folderProblem({ machineId, mode: asNew ? 'new' : 'existing', path: directory, gitInit }, machine, !!machine && isMachineOnline(machine));
  const newProblem = newFolder ? folderProblemOf(true) : null;
  const blocker = newProblem ? 'directory' : startBlocker({ ready, goal, directory });
  const blockerText = blocker === 'goal' ? c.needGoal : blocker === 'directory' ? c.needDirectory : null;
  const showMissing = () => {
    if (blocker === 'directory') { setConfigOpen(true); requestAnimationFrame(() => directoryRef.current?.focus()); }
    else if (blocker === 'goal') goalRef.current?.focus();
  };
  return <form className="team-start-form" onSubmit={async event => {
    event.preventDefault(); if (busy || !ready || newProblem) return;
    if (!restored || !key) return;
    const path = directory.trim();
    const home = machine?.metadata?.homeDir;
    const resolvedPath = home && (path === '~' || path.startsWith('~/')) ? home.replace(/\/$/, '') + path.slice(1) : path;
    const title = name.trim() || teamNameFromGoal(goal);
    if (!goal.trim() || !path || !title) return;
    setBusy(true); setError('');
    let launchDirectory = resolvedPath;
    if (newFolder) {
      const made = await machineFsMkdir(machineId, path, { gitInit });
      if (!made.ok) {
        if (mounted.current) { setBusy(false); setError(made.code === 'exists' ? folderCopy.existsTeam : made.code === 'outside-home' ? folderCopy.problem['outside-home'] : `${folderCopy.mkdirFailed} (${made.code})`); }
        return;
      }
      launchDirectory = made.path;
      if (mounted.current) { setNewFolder(false); setDirectory(made.path); }
    }
    const launch: TeamLaunchInput = { goal: goal.trim(), directory: launchDirectory, assistant, ...(model.trim() ? { model: model.trim() } : {}) };
    let sending: LaunchIntent | null = null;
    let resuming = true;
    try {
      resuming = readPendingIntent(key, value => intentSchema.parse(value)) !== null;
      const project = projectsReady ? teamProjectFromChoice(projectChoice) : undefined;
      sending = retainPendingIntent(key, { requestId: crypto.randomUUID(), name: title, machineId, launch, ...(project ? { project } : {}) }, value => intentSchema.parse(value));
      setIntent(sending);
      setMachine(sending.machineId); setDirectory(sending.launch.directory); setGoal(sending.launch.goal); setName(sending.name); setModel(sending.launch.model ?? ''); setAssistant(sending.launch.assistant);
      const team = await onStart(sending.name, sending.machineId, sending.launch, sending.requestId, sending.project);
      clearPendingIntent(key, sending.requestId);
      if (mounted.current && currentKey.current === key) { recordRecentMachinePath(sending.machineId, sending.launch.directory); setIntent(null); onStarted(team); }
    } catch (failure) {
      const safeToChange = !!sending && failure instanceof TeamsApiError && canReplaceRejectedIntent(resuming, failure.status);
      if (safeToChange && sending) {
        clearPendingIntent(key, sending.requestId);
        if (mounted.current && currentKey.current === key) setIntent(null);
      }
      if (mounted.current && currentKey.current === key) setError(safeToChange ? (zh ? '请求被拒绝，可以修改设置后重试。' : 'The request was rejected. You can change the settings and try again.') : c.error);
    } finally { if (mounted.current && currentKey.current === key) setBusy(false); }
  }}>
    <p className="team-chat-intro"><Bot size={20} />{c.chatIntro}</p>
    <fieldset disabled={busy || !!intent || !restored}>
      <label>{c.goal}<textarea ref={goalRef} name="goal" value={goal} onChange={e => setGoal(e.target.value)} required maxLength={32000} placeholder={c.goalHint} autoFocus aria-describedby={`${fieldId}-goal-note`} /></label>
      <p id={`${fieldId}-goal-note`} className="team-start-assurance team-start-goal-note">{c.goalNote}</p>
      <div className="team-start-config">
      <button type="button" className="team-start-toggle" aria-expanded={configOpen} aria-controls="team-start-config" onClick={() => setConfigOpen(open => !open)}><ChevronDown size={16} aria-hidden className="team-start-chev" />{c.configure}<span className="team-start-context">{machine ? machineLabel(machine) : c.machine} · {directory || c.project} · {assistant === 'claude' ? 'Claude Code' : assistant === 'codex' ? 'Codex' : 'pi'}</span></button>
      <CollapsePanel id="team-start-config" open={configOpen} className="team-start-config-body">

      {!fixedMachine && <div className="teams-field"><span id={`${fieldId}-machine`}>{c.machine}</span><Combobox variant="soft" size="md" label={c.machine} labelledBy={`${fieldId}-machine`} placeholder={c.machine} required value={machineId || null} options={machines.map(m => ({ value: m.id, label: machineLabel(m), meta: isMachineOnline(m) ? undefined : t('status.offline') }))} onChange={value => { const next = machines.find(m => m.id === value); setMachine(value); setDirectory(''); setPicking(false); const a = preferredTeamAssistant(next?.metadata, assistant); if (a !== assistant) { setAssistant(a); setModel(''); } }} /></div>}
      <label>{c.project}<div className="team-folder-input"><SuggestInput inputRef={directoryRef} value={directory} onValueChange={setDirectory} required aria-label={c.project} suggestions={(presets ?? []).map(p => ({ value: p.path, label: p.path }))} placeholder="/path/to/project" /><button type="button" disabled={!machine || !isMachineOnline(machine)} onClick={() => setPicking(!picking)}><FolderOpen size={16} />{c.browse}</button></div></label>
      {!newFolderBlocked && <Checkbox className="team-folder-new" checked={newFolder} onCheckedChange={on => { setNewFolder(on); setPicking(false); if (on) setDirectory(defaultNewFolder(name.trim() || goal.trim().split('\n')[0])); }}>{folderCopy.create}</Checkbox>}
      {newFolder && <Checkbox className="team-folder-new" checked={gitInit} onCheckedChange={setGitInit}>{folderCopy.gitInit}</Checkbox>}
      {newFolder && newProblem && <p className="team-start-blocker" role="status">{folderCopy.problem[newProblem]}</p>}
      {picking && machine && <div className="team-folder-browser"><FsBrowser machineId={machineId} initialPath={directory || machine.metadata?.homeDir || '/'} onPickDir={path => { setDirectory(path); setPicking(false); }} /></div>}
      {/* B-698: the launch harness/model also become the team's defaults for new members (server reducer). */}
      <div className="team-start-options"><TeamHarnessModelFields machineId={machineId} assistant={assistant} model={model} onAssistant={setAssistant} onModel={setModel} harnessLabel={c.leadAndMembers} /><label>{c.name}<input name="name" value={name} onChange={e => setName(e.target.value)} maxLength={128} placeholder={teamNameFromGoal(goal)} /></label></div>
      </CollapsePanel></div>
      {projectsReady && <div className="team-start-project"><label htmlFor="team-start-project">{c.teamProject}</label><ProjectPicker id="team-start-project" value={projectChoice} onChange={setProjectChoice} projects={projectsSnap.projects} newName={name.trim() || teamNameFromGoal(goal)} noneLabel={c.teamProjectNone} /><p className="team-start-assurance">{c.teamProjectHint}</p></div>}
    </fieldset>
    {!ready && <p role="status">{machine ? isMachineOnline(machine) ? c.upgrade : c.offline : c.machineRequired} <Link to={machine ? `/machine/${machine.id}` : '/machine/connect'}>{c.machineSettings} →</Link></p>}
    {intent && <p role="status">{zh ? '已有启动请求，已恢复原来的目标和设置。继续会查询或完成同一次启动，不会创建第二个团队。' : 'Your original goal and settings are restored. Continue the saved launch without creating another team.'}</p>}
    {error && <p className="teams-error" role="alert">{error}</p>}
    <p className="team-start-assurance">{c.automatic}</p>
    {blockerText && !busy && <p className="team-start-blocker" role="status" id="team-start-blocker"><button type="button" className="team-start-missing" onClick={showMissing}>{blockerText}</button></p>}
    <button className="teams-primary team-start-send" aria-busy={busy} aria-describedby={blockerText ? 'team-start-blocker' : undefined} disabled={busy || !ready || !restored || !goal.trim() || !directory.trim() || !!newProblem}>{busy ? <Spinner size={16} /> : <ArrowUp size={16} />}{busy ? c.preparing : intent ? (zh ? '继续启动' : 'Continue launch') : c.start}</button>
  </form>;
}
