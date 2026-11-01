/**
 * B-850c (design F3, Q3): which account a new session starts on — the draft
 * card and the new-session dialog. 「机器默认 · X」 = send nothing (the daemon
 * applies its default); an unusable choice is stopped here, before anything is
 * created, with a way to fix it (never a silent fall back to the machine login).
 * Old CLI: one read-only line, 「本机登录 · 升级 CLI」.
 */
import { Combobox } from '@/ui/Combobox';
import type { SelectOption } from '@/ui/SelectMenu';
import { useTranslation } from '@/i18n/useTranslation';
import {
    accountDisplayStatus,
    accountUsable,
    accountsForAgent,
    agentHasAccounts,
    machineHasAgentAccounts,
    readMachineAgentProfiles,
    projectSpawnAccount,
    resolveSpawnAccount,
    type AgentProfilesState,
    type SpawnAccountChoice,
    type SpawnAccountResolution,
} from '@/sync/agentProfiles';
import type { ProjectAgentProfile } from '@slopus/happy-wire';
import { accountKindText, accountStatusText } from './accountText';
import './accounts.css';

const DEFAULT_KEY = '__default__';
const MACHINE_KEY = '__machine__';

type T = ReturnType<typeof useTranslation>['t'];

export function choiceToKey(choice: SpawnAccountChoice): string {
    return choice === undefined ? DEFAULT_KEY : choice === null ? MACHINE_KEY : choice;
}
export function keyToChoice(key: string): SpawnAccountChoice {
    return key === DEFAULT_KEY ? undefined : key === MACHINE_KEY ? null : key;
}

/** Why a new session cannot start on this choice (Q3), or null. */
export function spawnAccountBlockText(resolution: SpawnAccountResolution, machineName: string, t: T): string | null {
    if (resolution.kind !== 'blocked') return null;
    const label = resolution.label ?? '';
    switch (resolution.reason) {
        case 'expired': return t('accounts.blockedExpired', { label, machine: machineName });
        case 'invalid': return t('accounts.blockedInvalid', { label, machine: machineName });
        case 'missing-secret': return t('accounts.blockedMissingSecret', { label, machine: machineName });
        default: return t('accounts.blockedMissing', { machine: machineName });
    }
}

/**
 * B-850d/e: the 「不选」 row says where the account comes from —
 * 「项目默认 · X」 when the session's project has one for this agent on this
 * machine, else 「机器默认 · X」 / 「机器默认 · 本机登录」.
 */
export function spawnDefaultOptionLabel(state: AgentProfilesState, agent: string, machineId: string, project: readonly ProjectAgentProfile[] | null | undefined, t: T): string {
    const fromProject = projectSpawnAccount(agent, { project, machineId });
    if (fromProject) {
        if (fromProject.id === null) return t('accounts.projectDefault', { label: t('accounts.machineLogin') });
        const account = state.accounts.find((a) => a.id === fromProject.id && a.agent === agent);
        const snapshot = project?.find((e) => e.agent === agent && e.id === fromProject.id)?.label;
        return t('accounts.projectDefault', { label: account?.label ?? snapshot ?? fromProject.id });
    }
    const id = state.defaults[agent];
    if (!id) return t('accounts.draftDefaultMachineLogin');
    const account = state.accounts.find((a) => a.id === id && a.agent === agent);
    return t('accounts.draftDefault', { label: account?.label ?? '?' });
}

/** B-850e: the project has an account for this agent, but on another machine (DESIGN F7). */
export function projectAccountElsewhere(agent: string, machineId: string, project: readonly ProjectAgentProfile[] | null | undefined): string | null {
    const entry = project?.find((e) => e.agent === agent);
    return entry && entry.machineId !== machineId ? entry.machineId : null;
}

export function SpawnAccountPicker({ machine, machineName, agent, value, onChange, onFix, labelId, variant = 'draft', project, machineNameOf }: {
    machine: { id: string; daemonState?: unknown } | null | undefined;
    machineName: string;
    agent: string;
    value: SpawnAccountChoice;
    onChange: (choice: SpawnAccountChoice) => void;
    /** open Settings → 模型与账号 for this machine */
    onFix: () => void;
    labelId: string;
    variant?: 'draft' | 'dialog';
    /** B-850e: the session's project `defaults.agentProfiles` (absent = no project) */
    project?: readonly ProjectAgentProfile[] | null;
    machineNameOf?: (machineId: string) => string;
}) {
    const { t } = useTranslation();
    if (!machine || !agentHasAccounts(agent)) return null;
    const state = readMachineAgentProfiles(machine);
    const labelClass = variant === 'draft' ? 'ps-draft-label' : 'ns-label';
    // Old CLI — or, for Codex, a CLI with Claude accounts only.
    if (!state || !machineHasAgentAccounts(state, agent)) {
        return <>
            <label className={labelClass} id={labelId}>{t('accounts.draftAccount')}</label>
            <span className="acc-old-cli" aria-labelledby={labelId} data-testid="spawn-account-old-cli">{t('accounts.machineLogin')} · {t('accounts.upgradeCliShort')}</span>
        </>;
    }
    const now = Date.now();
    const accounts = accountsForAgent(state, agent);
    const launch = { project, machineId: machine.id };
    const options: SelectOption[] = [
        { value: DEFAULT_KEY, label: spawnDefaultOptionLabel(state, agent, machine.id, project, t) },
        { value: MACHINE_KEY, label: t('accounts.machineLogin') },
        ...accounts.map((account) => {
            const status = accountDisplayStatus(account, now);
            return {
                value: account.id,
                label: account.label,
                meta: status === 'ok' ? accountKindText(account.kind, t) : `${accountKindText(account.kind, t)} · ${accountStatusText(status, account, t, now)}`,
                ...(accountUsable(status) ? {} : { disabled: true }),
            };
        }),
    ];
    const key = choiceToKey(value);
    // A chosen id that vanished stays visible (and blocked) instead of silently becoming the default.
    if (!options.some((o) => o.value === key)) options.push({ value: key, label: t('accounts.unknownAccount'), meta: t('accounts.statusMissingSecret'), disabled: true });
    return <>
        <label className={labelClass} id={labelId}>{t('accounts.draftAccount')}</label>
        <Combobox label={t('accounts.draftAccount')} labelledBy={labelId} value={key} onChange={(next) => onChange(keyToChoice(next))} options={options}
            searchable={false} {...(variant === 'dialog' ? { size: 'md' as const } : {})} />
        <SpawnAccountBlock resolution={resolveSpawnAccount(state, agent, value, now, launch)} machineName={machineName} onFix={onFix} />
        {value === undefined && (() => {
            const elsewhere = projectAccountElsewhere(agent, machine.id, project);
            return elsewhere ? <p className="acc-choice-hint ps-draft-note" data-testid="spawn-account-elsewhere">{t('accounts.projectOtherMachine', { machine: machineNameOf?.(elsewhere) ?? elsewhere.slice(0, 8) })}</p> : null;
        })()}
    </>;
}

function SpawnAccountBlock({ resolution, machineName, onFix }: { resolution: SpawnAccountResolution; machineName: string; onFix: () => void }) {
    const { t } = useTranslation();
    const text = spawnAccountBlockText(resolution, machineName, t);
    if (!text) return null;
    return <p className="acc-blocked" role="alert" data-testid="spawn-account-blocked">
        {text} <button type="button" onClick={onFix}>{t('accounts.blockedFix')}</button>
    </p>;
}
