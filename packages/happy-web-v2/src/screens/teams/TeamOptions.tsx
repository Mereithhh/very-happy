import type { TeamState } from '@slopus/happy-wire';
import { useEffect, useState } from 'react';
import { useFirstUseCopy } from './firstUseCopy';
import { TeamHarnessModelFields } from './TeamHarnessModelFields';
import type { TeamAssistant } from './teamHarnessModel';
/** B-698: member harness + default model are selects scoped to the team's machine (TeamHarnessModelFields). */
export function TeamOptions({team, disabled, onSave}: {team: TeamState; disabled: boolean; onSave: (defaults: {assistant: TeamAssistant; model?: string; maxParallel: number}) => Promise<void>}) {
  const c = useFirstUseCopy();
  const [busy,setBusy] = useState(false);
  const [assistant, setAssistant] = useState<TeamAssistant>(team.defaults?.assistant ?? 'claude');
  const [model, setModel] = useState(team.defaults?.model ?? '');
  const [maxParallel, setMaxParallel] = useState(team.defaults?.maxParallel ?? 3);
  const savedKey = JSON.stringify(team.defaults ?? null);
  useEffect(() => { setAssistant(team.defaults?.assistant ?? 'claude'); setModel(team.defaults?.model ?? ''); setMaxParallel(team.defaults?.maxParallel ?? 3); }, [savedKey]);
  return <section><h2>{c.options}</h2><p>{c.settingsHint}</p><form onSubmit={async e=>{
    e.preventDefault();
    setBusy(true); try { await onSave({assistant, ...(model.trim() ? {model: model.trim()} : {}), maxParallel}); } finally {setBusy(false);}
  }}><TeamHarnessModelFields machineId={team.machineId} assistant={assistant} model={model} onAssistant={setAssistant} onModel={setModel} harnessLabel={c.members} disabled={disabled || busy} /><label>{c.parallel}<input disabled={disabled || busy} name="maxParallel" type="number" min={1} max={16} value={maxParallel} onChange={e => setMaxParallel(Number(e.target.value))} required /></label><button disabled={disabled || busy}>{c.save}</button></form></section>;
}
