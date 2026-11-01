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
    readMachineAgentProfiles,
    resolveSpawnAccount,
    type SpawnAccountChoice,
    type SpawnAccountResolution,
} from '@/sync/agentProfiles';
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

export function SpawnAccountPicker({ machine, machineName, agent, value, onChange, onFix, labelId, variant = 'draft' }: {
    machine: { id: string; daemonState?: unknown } | null | undefined;
    machineName: string;
    agent: string;
    value: SpawnAccountChoice;
    onChange: (choice: SpawnAccountChoice) => void;
    /** open Settings → 模型与账号 for this machine */
    onFix: () => void;
    labelId: string;
    variant?: 'draft' | 'dialog';
}) {
    const { t } = useTranslation();
    if (!machine || !agentHasAccounts(agent)) return null;
    const state = readMachineAgentProfiles(machine);
    const labelClass = variant === 'draft' ? 'ps-draft-label' : 'ns-label';
    if (!state) {
        return <>
            <label className={labelClass} id={labelId}>{t('accounts.draftAccount')}</label>
            <span className="acc-old-cli" aria-labelledby={labelId} data-testid="spawn-account-old-cli">{t('accounts.machineLogin')} · {t('accounts.upgradeCliShort')}</span>
        </>;
    }
    const now = Date.now();
    const accounts = accountsForAgent(state, agent);
    const defaultAccount = state.defaults[agent] ? accounts.find((a) => a.id === state.defaults[agent]) : undefined;
    const options: SelectOption[] = [
        { value: DEFAULT_KEY, label: defaultAccount ? t('accounts.draftDefault', { label: defaultAccount.label }) : state.defaults[agent] ? t('accounts.draftDefault', { label: '?' }) : t('accounts.draftDefaultMachineLogin') },
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
        <SpawnAccountBlock resolution={resolveSpawnAccount(state, agent, value, now)} machineName={machineName} onFix={onFix} />
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
