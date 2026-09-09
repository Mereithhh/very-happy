import type { TeamState } from '@slopus/happy-wire';
import { useState } from 'react';
import { useFirstUseCopy } from './firstUseCopy';
export function TeamOptions({team, disabled, onSave}: {team: TeamState; disabled: boolean; onSave: (defaults: {assistant: 'claude' | 'codex' | 'pi-acp'; model?: string; maxParallel: number}) => Promise<void>}) {
  const c = useFirstUseCopy();
  const [busy,setBusy] = useState(false);
  return <section><h2>{c.options}</h2><p>{c.settingsHint}</p><form key={JSON.stringify(team.defaults)} onSubmit={async e=>{
    e.preventDefault(); const f = new FormData(e.currentTarget); const model = String(f.get('model') ?? '').trim();
    setBusy(true); try { await onSave({assistant:String(f.get('assistant')) as 'claude'|'codex'|'pi-acp', ...(model ? {model} : {}), maxParallel:Number(f.get('maxParallel'))}); } finally {setBusy(false);}
  }}><label>{c.members}<select disabled={disabled || busy} name="assistant" onChange={e => { const input = e.currentTarget.form?.elements.namedItem('model'); if (input instanceof HTMLInputElement) input.value = ''; }} defaultValue={team.defaults?.assistant ?? 'claude'}><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="pi-acp">pi</option></select></label><label>{c.model}<input disabled={disabled || busy} name="model" defaultValue={team.defaults?.model ?? ''} maxLength={128} placeholder={c.modelHint} /></label><label>{c.parallel}<input disabled={disabled || busy} name="maxParallel" type="number" min={1} max={16} defaultValue={team.defaults?.maxParallel ?? 3} required /></label><button disabled={disabled || busy}>{c.save}</button></form></section>;
}
