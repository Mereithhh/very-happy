/**
 * B-850c Settings → 模型与账号 → one machine's accounts (design §2, F4–F6).
 * Source of truth is `daemonState.agentProfiles` (trusted only from the current
 * daemon run); after an RPC the fresher `agent-profile-list` answer is shown
 * until the daemon's republish catches up. An old CLI gets one row:
 * 「本机登录 · 升级 CLI」.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FlaskConical, KeyRound, LogIn, MoreHorizontal, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { ActionDropdownMenu, Badge, Button, Item, ItemGroup, toast, type MenuItemDef } from '@/ui';
import { Combobox } from '@/ui/Combobox';
import { Modal } from '@/modal';
import { useTranslation } from '@/i18n/useTranslation';
import type { Machine } from '@/sync/storageTypes';
import { isMachineOnline, machineLabel } from '@/utils/machineUtils';
import {
    ACCOUNT_AGENTS,
    accountDisplayStatus,
    accountKindTag,
    accountNeedsRelogin,
    accountStatusTone,
    accountsForAgent,
    readMachineAgentProfiles,
    type AgentProfileSummary,
    type AgentProfilesState,
} from '@/sync/agentProfiles';
import { agentProfileList, agentProfileRemove, agentProfileRename, agentProfileSetDefault, agentProfileTest } from '@/sync/agentProfileOps';
import { accountDetailText, accountErrorText, accountKindText, accountStatusText } from './accountText';
import { AddAccountDialog } from './AddAccountDialog';
import './accounts.css';

const AGENT_TITLES: Record<string, string> = { claude: 'Claude' };
const MACHINE_LOGIN = '__machine__';

/** The fresher of the daemon's published state and our last RPC answer. */
export function useMachineAccounts(machine: Machine | null | undefined): { state: AgentProfilesState | null; refresh: () => Promise<void>; apply: (next: AgentProfilesState) => void } {
    const published = readMachineAgentProfiles(machine);
    const [local, setLocal] = useState<{ machineId: string; state: AgentProfilesState } | null>(null);
    const machineId = machine?.id ?? '';
    const own = local?.machineId === machineId ? local.state : null;
    const state = published && own && own.daemonPid === published.daemonPid && own.updatedAt > published.updatedAt ? own : published;
    return {
        state,
        apply: (next) => setLocal({ machineId, state: next }),
        refresh: async () => {
            if (!machineId) return;
            const result = await agentProfileList(machineId);
            if (result.ok) setLocal({ machineId, state: result.data });
        },
    };
}

export function MachineAccounts({ machine }: { machine: Machine }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { state, refresh, apply } = useMachineAccounts(machine);
    const online = isMachineOnline(machine);
    const name = machineLabel(machine);
    const [adding, setAdding] = useState(false);
    const [relogin, setRelogin] = useState<{ accountId: string; label: string } | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const now = Date.now();

    // Deep link from the unavailable banner: ?relogin=<accountId>.
    const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    const reloginParam = params?.get('relogin') ?? null;
    useEffect(() => {
        if (!reloginParam || !state) return;
        const account = state.accounts.find((a) => a.id === reloginParam);
        if (account && accountKindTag(account.kind) === 'subscription') setRelogin({ accountId: account.id, label: account.label });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reloginParam, !!state]);

    if (!state) {
        return <ItemGroup settingId="models.accounts" title={t('accounts.accountsGroup', { agent: 'Claude' })}>
            <Item title={t('accounts.machineLogin')} subtitle={t('accounts.upgradeCli')}
                right={<Button size="sm" onClick={() => navigate(`/machine/${encodeURIComponent(machine.id)}`)}>{t('accounts.upgradeCliShort')}</Button>} />
        </ItemGroup>;
    }

    const run = async (key: string, fn: () => Promise<void>) => {
        setBusy(key);
        try { await fn(); } finally { setBusy(null); }
    };

    const test = (account: AgentProfileSummary) => run(`test:${account.id}`, async () => {
        const result = await agentProfileTest(machine.id, account.id);
        if (!result.ok) { toast.error(accountErrorText(result, t)); return; }
        if (result.data.status === 'ok') toast.success(t('accounts.testOk', { label: result.data.label }));
        else toast.error(t('accounts.testFailed', { label: result.data.label, detail: result.data.statusDetail ?? accountStatusText(accountDisplayStatus(result.data), result.data, t) }));
        await refresh();
    });

    const rename = async (account: AgentProfileSummary) => {
        const next = (await Modal.prompt(t('accounts.rename'), t('accounts.renamePrompt'), { defaultValue: account.label }))?.trim();
        if (!next || next === account.label) return;
        await run(`rename:${account.id}`, async () => {
            const result = await agentProfileRename(machine.id, account.id, next.slice(0, 60));
            if (!result.ok) { toast.error(accountErrorText(result, t)); return; }
            await refresh();
        });
    };

    const remove = async (account: AgentProfileSummary) => {
        const ok = await Modal.confirm(t('accounts.removeConfirmTitle', { label: account.label }), t('accounts.removeConfirmBody', { machine: name }), { confirmText: t('accounts.remove'), destructive: true });
        if (!ok) return;
        await run(`remove:${account.id}`, async () => {
            let result = await agentProfileRemove(machine.id, account.id);
            if (!result.ok && result.code === 'in-use') {
                // In use: say what a forced delete does (sessions stop, never fall back), then allow it.
                const force = await Modal.confirm(t('accounts.removeInUseTitle', { label: account.label }), t('accounts.removeInUseBody', { count: result.sessions?.length ?? 1 }), { confirmText: t('accounts.removeForce'), destructive: true });
                if (!force) return;
                result = await agentProfileRemove(machine.id, account.id, true);
            }
            if (!result.ok) { toast.error(accountErrorText(result, t)); return; }
            toast.success(t('accounts.removed', { label: account.label }));
            await refresh();
        });
    };

    const setDefault = (agent: string, accountId: string | null) => run(`default:${agent}`, async () => {
        const result = await agentProfileSetDefault(machine.id, agent, accountId);
        if (!result.ok) { toast.error(accountErrorText(result, t)); return; }
        apply(result.data);
    });

    return <>
        {ACCOUNT_AGENTS.map((agent) => {
            const accounts = accountsForAgent(state, agent);
            const defaultId = state.defaults[agent] ?? null;
            const defaultOptions = [
                { value: MACHINE_LOGIN, label: t('accounts.machineLogin') },
                ...accounts.map((a) => ({ value: a.id, label: a.label, meta: accountKindText(a.kind, t) })),
            ];
            return <ItemGroup key={agent} settingId="models.accounts" title={t('accounts.accountsGroup', { agent: AGENT_TITLES[agent] ?? agent })} footer={t('accounts.accountsFooter')}>
                {!online && <Item title={t('accounts.offline')} />}
                <Item title={t('accounts.defaultRow')} right={
                    <Combobox label={t('accounts.defaultRow')} variant="soft" size="sm" className="acc-default-picker" searchable={false}
                        value={defaultId && accounts.some((a) => a.id === defaultId) ? defaultId : MACHINE_LOGIN}
                        disabled={!online || busy === `default:${agent}`}
                        onChange={(value) => void setDefault(agent, value === MACHINE_LOGIN ? null : value)}
                        options={defaultOptions} />
                } />
                <Item title={<span className="acc-title">{t('accounts.machineLogin')}{!defaultId && <span className="acc-tag">{t('accounts.defaultBadge')}</span>}</span>}
                    subtitle={t('accounts.machineLoginSubtitle')} />
                {accounts.map((account) => <AccountRow key={account.id} account={account} isDefault={defaultId === account.id} now={now}
                    online={online} busy={busy} onTest={test} onRename={rename} onRemove={remove}
                    onSetDefault={(a) => void setDefault(agent, a.id)} onRelogin={(a) => setRelogin({ accountId: a.id, label: a.label })} />)}
                <Item title={<span className="acc-add"><Plus size={15} aria-hidden="true" />{t('accounts.add')}</span>} disabled={!online} onClick={() => setAdding(true)} />
            </ItemGroup>;
        })}
        <AddAccountDialog open={adding || !!relogin} onOpenChange={(open) => { if (!open) { setAdding(false); setRelogin(null); void refresh(); } }}
            machineId={machine.id} machineName={name} kinds={state.kinds} relogin={relogin} />
    </>;
}

function AccountRow({ account, isDefault, now, online, busy, onTest, onRename, onRemove, onSetDefault, onRelogin }: {
    account: AgentProfileSummary;
    isDefault: boolean;
    now: number;
    online: boolean;
    busy: string | null;
    onTest: (a: AgentProfileSummary) => void;
    onRename: (a: AgentProfileSummary) => void;
    onRemove: (a: AgentProfileSummary) => void;
    onSetDefault: (a: AgentProfileSummary) => void;
    onRelogin: (a: AgentProfileSummary) => void;
}) {
    const { t } = useTranslation();
    const status = accountDisplayStatus(account, now);
    const editable = online && !account.legacy;
    const needsRelogin = accountNeedsRelogin(account.kind, status);
    const items: MenuItemDef[] = useMemo(() => [
        { key: 'test', label: t('accounts.test'), icon: FlaskConical, disabled: !online, onSelect: () => onTest(account) },
        ...(needsRelogin && editable ? [{ key: 'relogin', label: t('accounts.relogin'), icon: LogIn, onSelect: () => onRelogin(account) }] : []),
        ...(isDefault ? [] : [{ key: 'default', label: t('accounts.setDefault'), icon: Star, disabled: !online, onSelect: () => onSetDefault(account) }]),
        { key: 'rename', label: t('accounts.rename'), icon: Pencil, disabled: !editable, onSelect: () => onRename(account) },
        { key: 'remove', label: t('accounts.remove'), icon: Trash2, danger: true, separatorBefore: true, disabled: !editable, onSelect: () => onRemove(account) },
    ], [t, online, editable, needsRelogin, isDefault, account, onTest, onRelogin, onSetDefault, onRename, onRemove]);
    const detail = [accountDetailText(account, t), account.legacy ? t('accounts.legacy') : null, account.statusDetail && status !== 'ok' ? account.statusDetail : null].filter(Boolean).join(' · ');
    return <Item
        settingId={`models.account.${account.id}`}
        left={<KeyRound size={16} aria-hidden="true" />}
        title={<span className="acc-title" data-testid="account-row" data-account-id={account.id} data-status={status}>
            <span className="acc-name">{account.label}</span>
            <span className="acc-tag">{accountKindText(account.kind, t)}</span>
            {isDefault && <span className="acc-tag">{t('accounts.defaultBadge')}</span>}
        </span>}
        subtitle={<Badge tone={accountStatusTone(status)}>{accountStatusText(status, account, t, now)}</Badge>}
        detail={detail || undefined}
        multiline
        right={<span className="acc-actions">
            {needsRelogin && editable
                ? <Button size="sm" onClick={() => onRelogin(account)}>{t('accounts.relogin')}</Button>
                : <Button size="sm" variant="ghost" loading={busy === `test:${account.id}`} disabled={!online} onClick={() => onTest(account)}>{t('accounts.test')}</Button>}
            <ActionDropdownMenu items={items} align="end" sheetTitle={account.label}>
                <button type="button" className="acc-more" aria-label={t('accounts.more', { label: account.label })}><MoreHorizontal size={16} /></button>
            </ActionDropdownMenu>
        </span>}
    />;
}
