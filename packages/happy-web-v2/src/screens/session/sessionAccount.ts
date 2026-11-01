/**
 * B-850c — a session's account in the run-setup panel and the unavailable
 * banner (design F2 / F6). Switching = `agent-profile-bind` (write the binding,
 * restart in place, history kept); the confirm says so, and that a different
 * organization starts with a cold prompt cache.
 */
import { useContext, useEffect, useSyncExternalStore } from 'react';
import { UNSAFE_NavigationContext } from 'react-router-dom';
import { Modal } from '@/modal';
import { toast } from '@/ui';
import { useSession } from '@/sync/storage';
import { normalizeAgentKey } from '@/sync/agentDefaults';
import { machineLabel } from '@/utils/machineUtils';
import {
    accountDisplayStatus,
    accountNeedsRelogin,
    accountStatusTone,
    accountUsable,
    accountsForAgent,
    agentHasAccounts,
    apiAccountModels,
    isApiAccount,
    planAccountSwitch,
    switchLanded,
    readMachineAgentProfiles,
    readSessionAgentProfile,
    sessionSupportsAgentProfiles,
    type AgentProfileSummary,
    type AgentProfilesState,
    type SessionAgentProfile,
} from '@/sync/agentProfiles';
import { accountErrorText, accountKindText, accountStatusText } from '@/components/accounts/accountText';
import type { useTranslation } from '@/i18n/useTranslation';

type T = ReturnType<typeof useTranslation>['t'];

export const MACHINE_LOGIN_KEY = '__machine__';

export function accountSettingsHref(machineId: string, relogin?: string): string {
    const q = new URLSearchParams({ machine: machineId });
    if (relogin) q.set('relogin', relogin);
    return `/settings/models-accounts?${q.toString()}`;
}

export type AccountRow = {
    key: string;
    name: string;
    tag?: string;
    status?: { text: string; tone: string };
    disabled?: boolean;
    action?: { label: string; onSelect: () => void };
};

export type AccountSection = {
    rows: AccountRow[];
    value: string;
    /** can a row be picked (capability + online)? */
    switchable: boolean;
    note?: { text: string; action?: { label: string; onSelect: () => void } };
    add?: { label: string; onSelect: () => void };
};

export interface SessionAccountFacts {
    machineId: string;
    machineName: string;
    state: AgentProfilesState | null;
    profile: SessionAgentProfile | null | undefined;
    capable: boolean;
    online: boolean;
}

/** Pure: everything the panel / banner need from the stores. null = this agent has no accounts. */
export function sessionAccountFacts(session: { metadata?: unknown; presence?: unknown } | null | undefined, machine: { id: string; daemonState?: unknown; metadata?: unknown; active?: boolean } | null | undefined): SessionAccountFacts | null {
    const metadata = (session?.metadata ?? null) as { flavor?: string | null; machineId?: string; agentProfile?: unknown; capabilities?: string[] } | null;
    if (!metadata || !agentHasAccounts(normalizeAgentKey(metadata.flavor ?? 'claude'))) return null;
    const machineId = metadata.machineId ?? '';
    return {
        machineId,
        machineName: machine ? machineLabel(machine as never) : machineId.slice(0, 8),
        state: readMachineAgentProfiles(machine),
        profile: readSessionAgentProfile(metadata.agentProfile),
        capable: sessionSupportsAgentProfiles(metadata),
        online: session?.presence === 'online' && machine?.active !== false,
    };
}

export function buildAccountSection(facts: SessionAccountFacts, t: T, actions: {
    openSettings: (relogin?: string) => void;
    openMachine: () => void;
}, now = Date.now()): AccountSection {
    const machineRow: AccountRow = { key: MACHINE_LOGIN_KEY, name: t('accounts.machineLogin') };
    if (!facts.state) {
        return { rows: [machineRow], value: MACHINE_LOGIN_KEY, switchable: false, note: { text: t('accounts.upgradeCli'), action: { label: t('accounts.upgradeCliShort'), onSelect: actions.openMachine } } };
    }
    if (!facts.capable) {
        return { rows: [machineRow], value: MACHINE_LOGIN_KEY, switchable: false, note: { text: t('accounts.oldWrapper') } };
    }
    const rows: AccountRow[] = [machineRow, ...accountsForAgent(facts.state, 'claude').map((account): AccountRow => {
        const status = accountDisplayStatus(account, now);
        const usable = accountUsable(status);
        return {
            key: account.id,
            name: account.label,
            tag: accountKindText(account.kind, t),
            status: status === 'ok' ? undefined : { text: accountStatusText(status, account, t, now), tone: accountStatusTone(status) },
            disabled: !usable,
            action: !usable && accountNeedsRelogin(account.kind, status) ? { label: t('accounts.relogin'), onSelect: () => actions.openSettings(account.id) } : undefined,
        };
    })];
    const value = facts.profile ? facts.profile.id : MACHINE_LOGIN_KEY;
    // The bound account may be gone from the list (deleted): keep it visible as what runs.
    if (facts.profile && !rows.some((row) => row.key === facts.profile!.id)) {
        rows.push({ key: facts.profile.id, name: facts.profile.label, tag: accountKindText(facts.profile.kind, t), status: { text: t('accounts.statusMissingSecret'), tone: 'err' }, disabled: true });
    }
    return {
        rows,
        value,
        switchable: facts.online,
        add: { label: t('accounts.addAccount'), onSelect: () => actions.openSettings() },
    };
}

/** API account: the model list comes from the account (wire: `models`, first = default). */
export function sessionApiModels(facts: SessionAccountFacts | null): { account: AgentProfileSummary | null; models: string[]; pinned: string | null } | null {
    const profile = facts?.profile;
    if (!facts || !profile || profile.status !== 'active' || !isApiAccount(profile.kind)) return null;
    const account = facts.state?.accounts.find((a) => a.id === profile.id) ?? null;
    const models = apiAccountModels(account, profile.model);
    return models.length ? { account, models, pinned: profile.model ?? models[0] } : null;
}

// ---- wire v2: session events ----

export type AccountEventKind = 'unavailable' | 'auth-failed' | 'warning';
const ACCOUNT_EVENT_KINDS: Record<string, AccountEventKind> = {
    'agent-profile-unavailable': 'unavailable',
    'agent-profile-auth-failed': 'auth-failed',
    'agent-profile-warning': 'warning',
};
export function accountEventKind(kind: string | undefined): AccountEventKind | null {
    return (kind && ACCOUNT_EVENT_KINDS[kind]) || null;
}

/**
 * Wire v2: with an account bound (`metadata.agentProfile` an object) the
 * machine-login 「Claude 登录失效 / 修复本机登录」 card is wrong — the account
 * was rejected, not the machine login.
 */
export function machineLoginCardApplies(metadata: { agentProfile?: unknown } | null | undefined): boolean {
    const profile = readSessionAgentProfile(metadata?.agentProfile);
    return !profile;
}

/**
 * The bound account was rejected mid-run (auth-failed): the wrapper still
 * reports it active, the daemon republishes it expired / invalid.
 */
export function boundAccountRejected(facts: SessionAccountFacts | null, now = Date.now()): { status: 'expired' | 'invalid' | 'missing-secret'; account: AgentProfileSummary } | null {
    const profile = facts?.profile;
    if (!facts?.state || !profile || profile.status !== 'active') return null;
    const account = facts.state.accounts.find((a) => a.id === profile.id);
    if (!account) return null;
    const status = accountDisplayStatus(account, now);
    return status === 'expired' || status === 'invalid' || status === 'missing-secret' ? { status, account } : null;
}

// ---- wire v2: a bind whose restart is still running ('pending') ----

type PendingSwitch = { targetId: string | null; label: string | null; at: number };
const PENDING_SWITCH_MAX_MS = 5 * 60_000;
const pendingSwitches = new Map<string, PendingSwitch>();
const pendingListeners = new Set<() => void>();
const notifyPending = () => { for (const listener of [...pendingListeners]) listener(); };
export function notePendingSwitch(sessionId: string, value: PendingSwitch | null): void {
    if (value) pendingSwitches.set(sessionId, value); else pendingSwitches.delete(sessionId);
    notifyPending();
}
function subscribePending(listener: () => void) { pendingListeners.add(listener); return () => { pendingListeners.delete(listener); }; }

/** 「重启中」 until the wrapper reports the target account (or 5 min pass). */
export function pendingSwitchFor(sessionId: string, profile: SessionAgentProfile | null | undefined, now = Date.now()): PendingSwitch | null {
    const pending = pendingSwitches.get(sessionId);
    if (!pending) return null;
    if (switchLanded(profile, pending.targetId) || now - pending.at > PENDING_SWITCH_MAX_MS) return null;
    return pending;
}

/** Pure: the confirm dialog's lines. */
export function switchConfirmLines(plan: ReturnType<typeof planAccountSwitch>, machineName: string, working: boolean, t: T): string[] {
    return [
        t('accounts.switchRestart', { machine: machineName }),
        `✓ ${t('accounts.switchHistory')}`,
        ...(working ? [`⚠ ${t('accounts.switchInterrupt')}`] : []),
        ...(plan.cacheMiss ? [`⚠ ${t('accounts.switchCache')}`] : []),
        ...(plan.model ? [t('accounts.switchModel', { model: plan.model })] : []),
    ];
}

/** Confirm, then bind + restart in place. Resolves true when the binding was written. */
export async function switchSessionAccount(input: {
    sessionId: string;
    facts: SessionAccountFacts;
    target: AgentProfileSummary | null;
    model?: string;
    working: boolean;
    /** API model change on the same account: shorter confirm */
    modelOnly?: boolean;
}, t: T): Promise<boolean> {
    const { facts, target } = input;
    const plan = planAccountSwitch(facts.profile, target, input.model);
    const ok = input.modelOnly && plan.model
        ? await Modal.confirm(t('accounts.apiModelTitle', { model: plan.model }), [t('accounts.apiModelBody'), ...(input.working ? [`⚠ ${t('accounts.switchInterrupt')}`] : [])].join('\n'), { confirmText: t('accounts.switchConfirm') })
        : await Modal.confirm(
            target ? t('accounts.switchTitle', { label: target.label }) : t('accounts.switchToMachineTitle'),
            switchConfirmLines(plan, facts.machineName, input.working, t).join('\n'),
            { confirmText: t('accounts.switchConfirm') },
        );
    if (!ok) return false;
    // Loaded on use: the RPC layer (apiSocket) stays out of the composer's import graph.
    const { agentProfileBind } = await import('@/sync/agentProfileOps');
    const result = await agentProfileBind(facts.machineId, { sessionId: input.sessionId, accountId: plan.accountId, ...(plan.model ? { model: plan.model } : {}) });
    if (!result.ok) { toast.error(t('accounts.switchFailed', { error: accountErrorText(result, t) })); return false; }
    if (result.data.restart === 'done') toast.success(t('accounts.switched', { label: plan.label ?? t('accounts.machineLogin') }));
    else if (result.data.restart === 'pending') {
        notePendingSwitch(input.sessionId, { targetId: plan.accountId, label: plan.label, at: Date.now() });
        toast.show(t('accounts.switchPending'), 'info');
    }
    else if (result.data.restart === 'skipped') toast.show(t('accounts.switchSkipped'), 'info');
    else toast.error(t('accounts.switchRestartFailed'));
    return true;
}

/** React glue for the composer and the banner; `machine` = the session's machine (callers already hold it). */
export function useSessionAccount(sessionId: string, machine: Parameters<typeof sessionAccountFacts>[1]): { facts: SessionAccountFacts | null; restarting: PendingSwitch | null; openSettings: (relogin?: string) => void; openMachine: () => void } {
    // Not useNavigate(): the composer also renders outside a Router (unit tests), where it throws.
    // The data router's navigator applies the basename itself.
    const navigator = useContext(UNSAFE_NavigationContext)?.navigator as { push(to: string): void } | undefined;
    const navigate = navigator ? (to: string) => navigator.push(to) : null;
    const session = useSession(sessionId);
    const machineId = (session?.metadata as { machineId?: string } | null | undefined)?.machineId ?? '';
    const facts = sessionAccountFacts(session, machine);
    useSyncExternalStore(subscribePending, () => pendingSwitches.get(sessionId));
    const restarting = pendingSwitchFor(sessionId, facts?.profile);
    const stale = !restarting && pendingSwitches.has(sessionId);
    useEffect(() => { if (stale) notePendingSwitch(sessionId, null); }, [stale, sessionId]);
    return {
        facts,
        restarting,
        openSettings: (relogin) => navigate?.(accountSettingsHref(machineId, relogin)),
        openMachine: () => navigate?.(`/machine/${encodeURIComponent(machineId)}`),
    };
}
