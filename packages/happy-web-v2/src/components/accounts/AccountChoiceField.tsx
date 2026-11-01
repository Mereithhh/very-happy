/**
 * B-850e: the account picker of the project / team / automation forms (wire
 * B-850d `AgentProfileRef`). Options: follow the next level, the machine
 * login, this machine's accounts for the agent (live labels; an unusable one
 * is shown with its status but not offered), and a stored ref that is no
 * longer on the machine (kept visible, never silently dropped).
 *
 * Gate: a machine without accounts, or whose daemon lacks `launch-accounts`,
 * says 「这台机器的 CLI 需要升级，账号选择不会生效」 — the choice still saves.
 */
import { Combobox } from '@/ui/Combobox';
import type { SelectOption } from '@/ui/SelectMenu';
import { useTranslation } from '@/i18n/useTranslation';
import { readMachineAgentProfiles } from '@/sync/agentProfiles';
import {
    accountChoiceGate,
    accountChoiceOptions,
    agentTakesAccount,
    choiceKey,
    keyToAccountChoice,
    type AccountChoice,
} from '@/sync/accountChoice';
import { accountKindText, accountStatusText } from './accountText';
import './accounts.css';

export function AccountChoiceField({ machine, agent, value, onChange, followLabel, label, labelId, hint, note, disabled, className = 'acc-choice-field', testId = 'account-choice' }: {
    machine: { id: string; daemonState?: unknown } | null | undefined;
    /** account agent ('claude' | 'codex'); others render nothing */
    agent: string;
    value: AccountChoice;
    onChange: (choice: AccountChoice) => void;
    /** words for "not chosen" — 「跟随团队默认 · X」 etc. */
    followLabel: string;
    label?: string;
    labelId: string;
    hint?: string;
    /** extra line under the picker (sticky: 「改账号会在下一次运行时原地切换这个会话」) */
    note?: string;
    disabled?: boolean;
    className?: string;
    testId?: string;
}) {
    const { t } = useTranslation();
    if (!agentTakesAccount(agent)) return null;
    const state = readMachineAgentProfiles(machine);
    const gate = accountChoiceGate(state, agent);
    const now = Date.now();
    const options: SelectOption[] = accountChoiceOptions(state, agent, value, { follow: followLabel, machineLogin: t('accounts.machineLogin') }, now).map((o) => {
        if (o.kind !== 'account') return { value: o.key, label: o.label };
        if (o.missing) return { value: o.key, label: o.label, meta: t('accounts.choiceMissing'), disabled: true };
        const account = o.account!;
        const kind = accountKindText(account.kind, t);
        return {
            value: o.key,
            label: o.label,
            meta: o.status === 'ok' ? kind : `${kind} · ${accountStatusText(o.status!, account, t, now)}`,
            ...(o.unusable ? { disabled: true } : {}),
        };
    });
    const text = label ?? t('accounts.choiceLabel');
    return <div className={className} data-testid={testId}>
        <span id={labelId}>{text}</span>
        <Combobox variant="soft" size="md" label={text} labelledBy={labelId} value={choiceKey(value)} disabled={disabled} searchable={false}
            options={options} onChange={(key) => onChange(keyToAccountChoice(key, state, value))} />
        {hint && <span className="acc-choice-hint">{hint}</span>}
        {gate !== 'ok' && <span className="acc-choice-gate" role="status" data-testid={`${testId}-gate`}>{t('accounts.gateUpgrade')}</span>}
        {note && <span className="acc-choice-hint" data-testid={`${testId}-note`}>{note}</span>}
    </div>;
}
