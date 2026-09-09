import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '@/i18n/useTranslation';
import { FolderOpen } from 'lucide-react';
import type { TeamState } from '@slopus/happy-wire';
import { z } from 'zod';
import { getServerUrl } from '@/sync/serverConfig';
import { TeamsApiError } from '@/sync/teams';
import { pendingIntentKey, readPendingIntent, retainPendingIntent, clearPendingIntent, canReplaceRejectedIntent } from './pendingIntent';
import { useAllMachines, useSetting, useProfile } from '@/sync/storage';
import { isMachineOnline, machineLabel } from '@/utils/machineUtils';
import { FsBrowser } from '@/screens/files/FsBrowser';
import { useFirstUseCopy } from './firstUseCopy';

export type TeamLaunchInput = { goal: string; directory: string; assistant: 'claude' | 'codex' | 'pi-acp'; model?: string };
export function supportsTeamLaunch(machine: { metadata?: unknown; active?: boolean; activeAt?: number }) {
  return (machine.metadata as { teamLaunchVersion?: number } | null)?.teamLaunchVersion === 1;
}
const intentSchema = z.object({ requestId: z.string().min(1), name: z.string().min(1), machineId: z.string().min(1), launch: z.object({ goal: z.string().min(1), directory: z.string().min(1), assistant: z.enum(['claude','codex','pi-acp']), model: z.string().optional() }) });
type LaunchIntent = z.infer<typeof intentSchema>;
export function TeamStartForm({ machineId: fixedMachine, intentScope = 'create', onStart, onStarted }: { machineId?: string; intentScope?: string; onStart: (name: string, machineId: string, launch: TeamLaunchInput, requestId: string) => Promise<TeamState>; onStarted: (team: TeamState) => void }) {
  const c = useFirstUseCopy();
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
  const [machineId, setMachine] = useState(fixedMachine ?? machines.find(m => isMachineOnline(m) && supportsTeamLaunch(m))?.id ?? machines[0]?.id ?? '');
  const [directory, setDirectory] = useState('');
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setRestored(false); setBusy(false); setError(''); setPicking(false);
    setGoal(''); setName(''); setModel(''); setAssistant('claude'); setDirectory('');
    setMachine(fixedMachine ?? '');
    if (!key) return;
    try {
      const saved = readPendingIntent(key, value => intentSchema.parse(value));
      setIntent(saved);
      if (saved) { setMachine(saved.machineId); setDirectory(saved.launch.directory); setGoal(saved.launch.goal); setName(saved.name); setModel(saved.launch.model ?? ''); setAssistant(saved.launch.assistant); }
      setRestored(true);
    } catch { setError(c.error); }
  }, [key]);
  useEffect(() => {
    if (!machineId && machines.length) setMachine(fixedMachine ?? machines.find(m => isMachineOnline(m) && supportsTeamLaunch(m))?.id ?? machines[0].id);
  }, [machineId, machines, fixedMachine]);
  const machine = machines.find(m => m.id === machineId);
  const ready = !!machine && isMachineOnline(machine) && supportsTeamLaunch(machine);
  return <form className="team-start-form" onSubmit={async event => {
    event.preventDefault(); if (busy || !ready) return;
    if (!restored || !key) return;
    const launch: TeamLaunchInput = { goal: goal.trim(), directory: directory.trim(), assistant, ...(model.trim() ? { model: model.trim() } : {}) };
    const title = name.trim() || launch.goal.split('\n')[0].slice(0, 128);
    if (!launch.goal || !launch.directory || !title) return;
    setBusy(true); setError('');
    let sending: LaunchIntent | null = null;
    let resuming = true;
    try {
      resuming = readPendingIntent(key, value => intentSchema.parse(value)) !== null;
      sending = retainPendingIntent(key, { requestId: crypto.randomUUID(), name: title, machineId, launch }, value => intentSchema.parse(value));
      setIntent(sending);
      setMachine(sending.machineId); setDirectory(sending.launch.directory); setGoal(sending.launch.goal); setName(sending.name); setModel(sending.launch.model ?? ''); setAssistant(sending.launch.assistant);
      const team = await onStart(sending.name, sending.machineId, sending.launch, sending.requestId);
      clearPendingIntent(key, sending.requestId);
      if (mounted.current && currentKey.current === key) { setIntent(null); onStarted(team); }
    } catch (failure) {
      const safeToChange = !!sending && failure instanceof TeamsApiError && canReplaceRejectedIntent(resuming, failure.status);
      if (safeToChange && sending) {
        clearPendingIntent(key, sending.requestId);
        if (mounted.current && currentKey.current === key) setIntent(null);
      }
      if (mounted.current && currentKey.current === key) setError(safeToChange ? (zh ? '请求被拒绝，可以修改设置后重试。' : 'The request was rejected. You can change the settings and try again.') : c.error);
    } finally { if (mounted.current && currentKey.current === key) setBusy(false); }
  }}>
    <fieldset disabled={busy || !!intent || !restored}>
      <label>{c.goal}<textarea name="goal" value={goal} onChange={e => setGoal(e.target.value)} required maxLength={32000} placeholder={c.goalHint} autoFocus /></label>
      {!fixedMachine && <label>{c.machine}<select value={machineId} onChange={e => { setMachine(e.target.value); setDirectory(''); setPicking(false); }} required><option value="">{c.machine}</option>{machines.map(m => <option value={m.id} key={m.id}>{machineLabel(m)}{!isMachineOnline(m) ? ' · offline' : ''}</option>)}</select></label>}
      <label>{c.project}<div className="team-folder-input"><input value={directory} onChange={e => setDirectory(e.target.value)} required list="team-projects" placeholder="/path/to/project" /><button type="button" disabled={!machine || !isMachineOnline(machine)} onClick={() => setPicking(!picking)}><FolderOpen size={16} />{c.browse}</button></div></label>
      <datalist id="team-projects">{(presets ?? []).map(p => <option value={p.path} key={p.id} />)}</datalist>
      {picking && machine && <div className="team-folder-browser"><FsBrowser machineId={machineId} initialPath={directory || machine.metadata?.homeDir || '/'} onPickDir={path => { setDirectory(path); setPicking(false); }} /></div>}
      <label>{c.lead}<select name="assistant" value={assistant} onChange={e => { setAssistant(e.target.value as TeamLaunchInput['assistant']); setModel(''); }}><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="pi-acp">pi</option></select></label>
      <details><summary>{c.options}</summary><label>{c.name}<input name="name" value={name} onChange={e => setName(e.target.value)} maxLength={128} /></label><label>{c.model}<input name="model" value={model} onChange={e => setModel(e.target.value)} maxLength={128} placeholder={c.modelHint} /></label></details>
    </fieldset>
    {!ready && <p role="status">{machine ? isMachineOnline(machine) ? c.upgrade : c.offline : c.machineRequired} <Link to={machine ? `/machine/${machine.id}` : '/machine/connect'}>{c.machineSettings} →</Link></p>}
    {intent && <p role="status">{zh ? '已有启动请求，已恢复原来的目标和设置。继续会查询或完成同一次启动，不会创建第二个团队。' : 'Your original goal and settings are restored. Continue the saved launch without creating another team.'}</p>}
    {error && <p className="teams-error" role="alert">{error}</p>}
    <p className="team-start-assurance">{c.automatic}</p>
    <button className="teams-primary" disabled={busy || !ready || !restored}>{busy ? c.preparing : intent ? (zh ? '继续启动' : 'Continue launch') : c.start}</button>
  </form>;
}
