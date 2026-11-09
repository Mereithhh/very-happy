import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { ProjectView } from '@slopus/happy-wire';
import { projectsApi } from '@/sync/projects';
import { useAllMachines } from '@/sync/storage';
import type { Machine } from '@/sync/storageTypes';
import { toast } from '@/ui/Toast';
import { Button } from '@/ui/Button';
import { useTranslation } from '@/i18n/useTranslation';
import { isMachineOnline, machineLabel } from '@/utils/machineUtils';
import { AccountChoiceField } from '@/components/accounts/AccountChoiceField';
import { AddAccountDialog } from '@/components/accounts/AddAccountDialog';
import { ACCOUNT_AGENTS, accountsForAgent, machineHasAgentAccounts, readMachineAgentProfiles } from '@/sync/agentProfiles';
import {
  accountChoiceDisplay,
  applyProjectAccountEdits,
  projectAccountCellKey,
  projectAccountDraft,
  projectAccountEdits,
  projectAccountMachineIds,
  PROJECT_ACCOUNT_ENTRIES_MAX,
  type AccountChoice,
} from '@/sync/accountChoice';
import type { ProjectCopy } from './projectCopy';

const AGENT_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };

/**
 * B-902 project settings 「账号」: per agent, one row per machine the project
 * lives on (its folders' machines, then any machine that already has a
 * setting) — accounts belong to one machine, so a company project on two
 * machines is set twice. Each cell: 跟随机器默认 · X / 本机登录 / an account.
 * Saving re-reads the project and writes only the cells changed here.
 * A machine with no account for the agent gets 「在 X 添加账号」 in place.
 */
export function ProjectAccountsSection({ project, c, editable, onChanged }: { project: ProjectView; c: ProjectCopy; editable: boolean; onChanged: () => Promise<void> }) {
  const { t } = useTranslation();
  const machines = useAllMachines({ includeOffline: true });
  const saved = project.defaults.agentProfiles ?? null;
  const machineIds = projectAccountMachineIds(project.folders, saved);
  const [initial] = useState(() => projectAccountDraft(saved, ACCOUNT_AGENTS, machineIds));
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<{ machine: Machine; agent: string } | null>(null);
  const edits = projectAccountEdits(initial, draft);

  const save = async () => {
    if (!edits.length || busy) return;
    setBusy(true);
    try {
      // Only this form's changed cells, applied onto what is saved now (another tab may have set other machines).
      const latest = (await projectsApi.get(project.id)).project;
      const next = applyProjectAccountEdits(latest.defaults.agentProfiles, edits);
      if ((next?.length ?? 0) > PROJECT_ACCOUNT_ENTRIES_MAX) { toast.error(t('accounts.projectTooMany', { max: PROJECT_ACCOUNT_ENTRIES_MAX })); return; }
      await projectsApi.update(project.id, { defaults: { ...latest.defaults, agentProfiles: next } });
      toast.success(c.saved);
      await onChanged();
    } catch {
      toast.error(c.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="pj-settings-accounts" className="pj-section" data-testid="project-accounts">
      <h2>{c.accounts}</h2>
      <p className="pj-muted pj-hint">{t('accounts.projectSectionHint')}</p>
      {machineIds.length === 0 ? (
        <p className="pj-muted" data-testid="project-accounts-empty">{t('accounts.projectNoMachines')} <a href="#folders" onClick={(e) => { e.preventDefault(); document.getElementById('pj-settings-folders')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }}>{t('accounts.projectAddFolder')}</a></p>
      ) : (
        <form className="pj-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          {ACCOUNT_AGENTS.map((agent) => (
            <fieldset key={agent} className="pj-account-agent" data-testid={`project-account-${agent}`} disabled={!editable}>
              <legend>{AGENT_NAMES[agent] ?? agent}</legend>
              {machineIds.map((machineId) => {
                const machine = machines.find((m) => m.id === machineId);
                const key = projectAccountCellKey(agent, machineId);
                return <AccountCell key={machineId} agent={agent} machineId={machineId} machine={machine} value={draft[key]} editable={editable}
                  changed={edits.some((e) => e.agent === agent && e.machineId === machineId)}
                  onChange={(choice) => setDraft((all) => ({ ...all, [key]: choice }))}
                  onAdd={machine ? () => setAdding({ machine, agent }) : undefined} />;
              })}
            </fieldset>
          ))}
          {editable && <div className="pj-form-foot">
            {edits.length > 0 && <span className="pj-muted" data-testid="project-accounts-changed">{t('accounts.projectChangedCount', { count: edits.length })}</span>}
            <Button type="submit" variant="primary" size="sm" disabled={!edits.length} loading={busy}>{c.save}</Button>
          </div>}
        </form>
      )}
      {adding && (() => {
        const state = readMachineAgentProfiles(adding.machine);
        return <AddAccountDialog open onOpenChange={(open) => { if (!open) setAdding(null); }}
          machineId={adding.machine.id} machineName={machineLabel(adding.machine)} agent={adding.agent}
          kinds={state?.kinds ?? []} codexProviders={state?.codexProviders ?? []} />;
      })()}
    </section>
  );
}

function AccountCell({ agent, machineId, machine, value, editable, changed, onChange, onAdd }: {
  agent: string;
  machineId: string;
  machine: Machine | undefined;
  value: AccountChoice;
  editable: boolean;
  changed: boolean;
  onChange: (choice: AccountChoice) => void;
  onAdd?: () => void;
}) {
  const { t } = useTranslation();
  const state = readMachineAgentProfiles(machine);
  const online = !!machine && isMachineOnline(machine);
  const name = machine ? machineLabel(machine) : machineId.slice(0, 8);
  // 「跟随机器默认 · X」 names what that machine would use (its default account, else its own login).
  const defaultId = state?.defaults[agent];
  const defaultLabel = defaultId ? state?.accounts.find((a) => a.id === defaultId && a.agent === agent)?.label : undefined;
  const followLabel = state ? t('accounts.followMachineIs', { label: defaultLabel ?? t('accounts.machineLogin') }) : t('accounts.followMachine');
  // A machine whose CLI serves accounts but has none for this agent yet: add one right here.
  const canAdd = editable && online && !!onAdd && machineHasAgentAccounts(state, agent) && accountsForAgent(state, agent).length === 0;
  const labelId = `pj-acc-${agent}-${machineId}`;
  // The chosen account is no longer on that machine: sessions there are refused (never the machine login) until fixed.
  const shown = accountChoiceDisplay(value, state);
  const missing = shown.kind === 'account' && shown.missing;
  return (
    <div className="pj-account-cell" data-testid={`project-account-${agent}-${machineId}`} data-changed={changed || undefined}>
      <AccountChoiceField machine={machine} agent={agent} value={value} onChange={onChange} followLabel={followLabel}
        label={online ? name : `${name} · ${t('status.offline')}`} labelId={labelId} testId={`project-account-${agent}-${machineId}-choice`} />
      {missing && <p className="acc-choice-gate pj-account-missing" role="status" data-testid={`project-account-${agent}-${machineId}-missing`}>
        {t('accounts.projectMissingHere', { label: shown.label, machine: name })}
      </p>}
      {canAdd && <p className="acc-choice-hint pj-account-add" data-testid={`project-account-${agent}-${machineId}-add`}>
        {t('accounts.projectNoAccountsHere', { machine: name, agent: AGENT_NAMES[agent] ?? agent })}{' '}
        <Button type="button" variant="ghost" size="sm" leftIcon={<Plus size={14} />} onClick={onAdd}>{t('accounts.projectAddHere', { machine: name })}</Button>
      </p>}
    </div>
  );
}
