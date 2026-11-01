import type { AgentProfileRef, TeamState } from '@slopus/happy-wire';
import { useEffect, useId, useState } from 'react';
import { useFirstUseCopy } from './firstUseCopy';
import { TeamHarnessModelFields } from './TeamHarnessModelFields';
import type { TeamAssistant } from './teamHarnessModel';
import { useMachine } from '@/sync/storage';
import { t } from '@/text';
import { AccountChoiceField } from '@/components/accounts/AccountChoiceField';
import { teamAgent, type AccountChoice } from '@/sync/accountChoice';

export type TeamOptionsDefaults = { assistant: TeamAssistant; model?: string; maxParallel: number; agentProfile?: AgentProfileRef | null };

/**
 * B-698: member harness + default model are selects scoped to the team's machine (TeamHarnessModelFields).
 * B-850e: the team default account (set-defaults replaces the whole object, so it is always sent back);
 * a new agent clears it — an account belongs to one agent.
 */
export function TeamOptions({team, disabled, onSave}: {team: TeamState; disabled: boolean; onSave: (defaults: TeamOptionsDefaults) => Promise<void>}) {
  const c = useFirstUseCopy();
  const id = useId();
  const machine = useMachine(team.machineId);
  const [busy,setBusy] = useState(false);
  const [assistant, setAssistantState] = useState<TeamAssistant>(team.defaults?.assistant ?? 'claude');
  const [model, setModel] = useState(team.defaults?.model ?? '');
  const [maxParallel, setMaxParallel] = useState(team.defaults?.maxParallel ?? 3);
  const [account, setAccount] = useState<AccountChoice>(team.defaults?.agentProfile);
  const setAssistant = (next: TeamAssistant) => { if (next !== assistant) setAccount(undefined); setAssistantState(next); };
  const savedKey = JSON.stringify(team.defaults ?? null);
  useEffect(() => { setAssistantState(team.defaults?.assistant ?? 'claude'); setModel(team.defaults?.model ?? ''); setMaxParallel(team.defaults?.maxParallel ?? 3); setAccount(team.defaults?.agentProfile); }, [savedKey]);
  return <section><h2>{c.options}</h2><p>{c.settingsHint}</p><form onSubmit={async e=>{
    e.preventDefault();
    setBusy(true); try { await onSave({assistant, ...(model.trim() ? {model: model.trim()} : {}), maxParallel, ...(account !== undefined ? { agentProfile: account } : {})}); } finally {setBusy(false);}
  }}><TeamHarnessModelFields machineId={team.machineId} assistant={assistant} model={model} onAssistant={setAssistant} onModel={setModel} harnessLabel={c.members} disabled={disabled || busy} />
    <AccountChoiceField machine={machine} agent={teamAgent(assistant)} value={account} onChange={setAccount} label={t('accounts.teamDefaultAccount')} labelId={`${id}-account`}
      followLabel={t('accounts.followMachine')} hint={t('accounts.teamDefaultAccountHint')} disabled={disabled || busy} className="teams-field acc-choice-field" testId="team-default-account" />
    <label>{c.parallel}<input disabled={disabled || busy} name="maxParallel" type="number" min={1} max={16} value={maxParallel} onChange={e => setMaxParallel(Number(e.target.value))} required /></label><button disabled={disabled || busy}>{c.save}</button></form></section>;
}
