/**
 * B-873 (spec §10): the issue assignee picker. Reuses the new-session pieces —
 * the machine Combobox (online / offline rows), the agent buttons with their
 * availability, `SpawnAccountPicker` (B-850 accounts) and the launcher model
 * list (live catalogs, B-844) — limited to the assignable agents (Claude,
 * Codex, pi; spec Q9). A machine whose issue worker has not polled in 2 min
 * is shown but not pickable (「离线」/「CLI 过旧」, spec §2 IssueWorker).
 */
import { useCallback, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ISSUE_ASSIGNABLE_AGENTS, type IssueAssignableAgent, type IssueAssignee, type IssueAssigneeView } from '@slopus/happy-wire';
import { Combobox, Segmented } from '@/ui';
import type { SelectOption } from '@/ui';
import { SpawnAccountPicker } from '@/components/accounts/SpawnAccountPicker';
import { accountsForAgent, readMachineAgentProfiles, type SpawnAccountChoice } from '@/sync/agentProfiles';
import { useAllMachines, useAllSessions } from '@/sync/storage';
import { useIssuesStore } from '@/sync/issuesStore';
import { useProjects } from '@/sync/projects';
import { collectRecentCatalogs } from '@/sync/launcherModels';
import { getLauncherModelModes } from '@/components/modelModeOptions';
import { collectPiModelOptions } from '@/sync/piModelOptions';
import { useLatestModelTable } from '@/sync/latestModels';
import { isAgentOffered, resolveAgentAvailability } from '@/utils/agentAvailability';
import { isMachineOnline, machineLabel } from '@/utils/machineUtils';
import { accountSettingsHref } from '@/screens/session/sessionAccount';
import { useTranslation, type TranslationKey } from '@/i18n/useTranslation';
import { machineWorkerState } from './issuesModel';
import type { IssuesCopy } from './issuesCopy';

export interface AssigneeDraft {
    kind: 'none' | 'self' | 'agent';
    machineId: string;
    agent: IssueAssignableAgent;
    account: SpawnAccountChoice;
    /** '' = default */
    model: string;
    directory: string;
}

export function assigneeToDraft(assignee: IssueAssigneeView | undefined): AssigneeDraft {
    const base: AssigneeDraft = { kind: 'none', machineId: '', agent: 'codex', account: undefined, model: '', directory: '' };
    if (!assignee || assignee.kind === 'none') return base;
    if (assignee.kind === 'self') return { ...base, kind: 'self' };
    if (assignee.kind !== 'agent') return base;
    const a = assignee as Extract<IssueAssigneeView, { kind: 'agent' }>;
    return {
        kind: 'agent',
        machineId: a.machineId,
        agent: (ISSUE_ASSIGNABLE_AGENTS as readonly string[]).includes(a.agent) ? a.agent as IssueAssignableAgent : 'codex',
        account: a.agentProfile === undefined ? undefined : a.agentProfile === null ? null : a.agentProfile.id,
        model: a.model ?? '',
        directory: a.directory ?? '',
    };
}

/** Draft → wire assignee. The account keeps the label it had when picked (wire AgentProfileRef). */
export function draftToAssignee(draft: AssigneeDraft, accountLabel: (id: string) => string | undefined): IssueAssignee | null {
    if (draft.kind === 'none') return { kind: 'none' };
    if (draft.kind === 'self') return { kind: 'self' };
    if (!draft.machineId) return null;
    const label = typeof draft.account === 'string' ? accountLabel(draft.account) : undefined;
    return {
        kind: 'agent',
        machineId: draft.machineId,
        agent: draft.agent,
        ...(draft.account === undefined ? {} : { agentProfile: draft.account === null ? null : { id: draft.account, ...(label ? { label } : {}) } }),
        ...(draft.model ? { model: draft.model } : {}),
        ...(draft.directory.trim() ? { directory: draft.directory.trim() } : {}),
    };
}

/** Account labels on a machine, for `draftToAssignee`. */
export function useAccountLabel(machineId: string, agent: string): (id: string) => string | undefined {
    const machines = useAllMachines({ includeOffline: true });
    const machine = machines.find((m) => m.id === machineId);
    return useCallback((id: string) => accountsForAgent(readMachineAgentProfiles(machine), agent).find((a) => a.id === id)?.label, [machine, agent]);
}

export function AssigneeFields({ draft, onChange, copy, status, projectId, idPrefix }: {
    draft: AssigneeDraft;
    onChange: (next: AssigneeDraft) => void;
    copy: IssuesCopy;
    /** the issue's (or new issue's) status: backlog only records the owner */
    status: string;
    projectId: string | null;
    idPrefix: string;
}) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const machines = useAllMachines({ includeOffline: true });
    const workers = useIssuesStore((s) => s.workers);
    const sessions = useAllSessions();
    const latestTable = useLatestModelTable();
    const projects = useProjects();
    const project = projectId ? projects.projects.find((p) => p.id === projectId) : undefined;
    const set = (patch: Partial<AssigneeDraft>) => onChange({ ...draft, ...patch });

    const machineOptions: SelectOption[] = useMemo(() => { const now = Date.now(); return machines.map((m) => {
        const state = machineWorkerState({ online: isMachineOnline(m), machineId: m.id }, workers, now);
        return { value: m.id, label: machineLabel(m), ...(state === 'ok' ? {} : { meta: state === 'offline' ? copy.offline : copy.cliOld, disabled: true }) };
    }); }, [machines, workers, copy]);
    const pickable = machineOptions.filter((o) => !o.disabled);

    // A new agent draft lands on the first pickable machine (project primary folder's machine first).
    useEffect(() => {
        if (draft.kind !== 'agent' || draft.machineId) return;
        const preferred = project?.folders.find((f) => f.primary)?.machineId;
        const next = pickable.find((o) => o.value === preferred)?.value ?? pickable[0]?.value;
        if (next) onChange({ ...draft, machineId: next });
    }, [draft, pickable, project, onChange]);

    const machine = machines.find((m) => m.id === draft.machineId);
    const translate = useCallback((key: string) => t(key as TranslationKey), [t]);
    const modelOptions: SelectOption[] = useMemo(() => {
        const catalogs = draft.agent === 'pi' ? [] : collectRecentCatalogs(sessions, draft.agent, draft.machineId || null);
        const modes = draft.agent === 'pi' ? collectPiModelOptions(sessions, [draft.model]) : getLauncherModelModes(draft.agent, catalogs, translate as never, latestTable);
        const list: SelectOption[] = [{ value: '', label: copy.modelDefault }];
        for (const mode of modes) if (mode.key !== 'default' && !list.some((o) => o.value === mode.key)) list.push({ value: mode.key, label: mode.name, ...(mode.description ? { description: mode.description } : {}) });
        if (draft.model && !list.some((o) => o.value === draft.model)) list.push({ value: draft.model, label: draft.model });
        return list;
    }, [sessions, draft.agent, draft.machineId, draft.model, translate, latestTable, copy]);

    const kinds = [
        { value: 'none' as const, label: copy.kindNone },
        { value: 'self' as const, label: copy.kindSelf },
        { value: 'agent' as const, label: copy.kindAgent },
    ];
    return (
        <div className="is-assignee-fields" data-testid="issue-assignee-fields">
            <Segmented label={copy.assignee} options={kinds} value={draft.kind} onChange={(kind) => set({ kind })} className="is-assignee-kind" />
            {draft.kind === 'agent' && (
                <>
                    <label className="ns-label" id={`${idPrefix}-machine`}>{copy.machine}</label>
                    {pickable.length === 0 && <p className="is-field-note">{copy.noMachines}</p>}
                    <Combobox label={copy.machine} labelledBy={`${idPrefix}-machine`} size="md" value={draft.machineId} options={machineOptions}
                        onChange={(machineId) => set({ machineId, account: undefined, model: '' })} />
                    <label className="ns-label">{copy.agent}</label>
                    <div className="ns-agents" role="group" aria-label={copy.agent}>
                        {ISSUE_ASSIGNABLE_AGENTS.filter((a) => isAgentOffered(machine?.metadata, a)).map((a) => {
                            const unavailable = !!machine && !resolveAgentAvailability(machine.metadata, a).available;
                            return (
                                <button key={a} type="button" className={`ns-agent${draft.agent === a ? ' is-on' : ''}${unavailable ? ' is-disabled' : ''}`}
                                    aria-pressed={draft.agent === a} aria-disabled={unavailable}
                                    onClick={() => { if (!unavailable) set({ agent: a, account: undefined, model: '' }); }}>
                                    <span>{a}</span>{unavailable && <span className="ns-agent-status">{copy.notInstalled}</span>}
                                </button>
                            );
                        })}
                    </div>
                    <SpawnAccountPicker machine={machine} machineName={machine ? machineLabel(machine) : ''} agent={draft.agent} value={draft.account}
                        onChange={(account) => set({ account })} labelId={`${idPrefix}-account`} variant="dialog"
                        project={project?.defaults.agentProfiles ?? null}
                        onFix={() => navigate(accountSettingsHref(draft.machineId))} />
                    <label className="ns-label" id={`${idPrefix}-model`}>{copy.model}</label>
                    <Combobox label={copy.model} labelledBy={`${idPrefix}-model`} size="md" value={draft.model} options={modelOptions} onChange={(model) => set({ model })} />
                    <label className="ns-label" htmlFor={`${idPrefix}-dir`}>{copy.directory}</label>
                    <input id={`${idPrefix}-dir`} className="ns-input" value={draft.directory} placeholder={copy.directoryPh} onChange={(e) => set({ directory: e.target.value })} />
                    <p className="is-field-note" data-testid="issue-assignee-run-note">{status === 'backlog' ? copy.backlogNote : copy.runsOnSave}</p>
                </>
            )}
        </div>
    );
}
