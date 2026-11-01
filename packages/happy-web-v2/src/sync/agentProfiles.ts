/**
 * B-850c — per-session accounts (「账号」; `agentProfile` on the wire).
 * Contract: B-850a wire v1 (`packages/happy-wire/src/agentProfiles.ts` on the
 * PR-C branch; spec specs/2026-11-session-accounts.md). Mirrored here like
 * claudeAuth.ts so the Web owns its trust gate and whitelists: every enum-ish
 * field is an open string and an unknown value reads as the neutral case
 * (AGENTS #14), so a newer CLI never makes this Web drop the whole object.
 *
 * An account belongs to ONE machine. Secrets never reach the Web: summaries
 * carry ids, labels, kinds, status, the endpoint and where the key comes from.
 * Pure module: no React, no stores.
 */
import { z } from 'zod';

/** Session metadata capability: the wrapper honours a binding and reports `metadata.agentProfile`. */
export const AGENT_PROFILE_SESSION_CAPABILITY = 'agent-profile-v1';

export const AGENT_PROFILE_RPC = {
    list: 'agent-profile-list',
    add: 'agent-profile-add',
    loginStart: 'agent-profile-login-start',
    loginSubmit: 'agent-profile-login-submit',
    loginStatus: 'agent-profile-login-status',
    loginCancel: 'agent-profile-login-cancel',
    test: 'agent-profile-test',
    rename: 'agent-profile-rename',
    remove: 'agent-profile-remove',
    setDefault: 'agent-profile-set-default',
    bind: 'agent-profile-bind',
} as const;

/** Agents that have accounts in this release (codex/pi/gemini come with PR-D/G). */
export const ACCOUNT_AGENTS = ['claude'] as const;

export const AgentProfileSummarySchema = z.object({
    id: z.string(),
    label: z.string(),
    agent: z.string(),
    kind: z.string(),
    status: z.string(),
    statusDetail: z.string().optional(),
    checkedAt: z.number().optional(),
    createdAt: z.number().optional(),
    expiresAt: z.number().optional(),
    baseUrl: z.string().optional(),
    models: z.array(z.string()).optional(),
    keySource: z.string().optional(),
    keyRef: z.string().optional(),
    legacy: z.boolean().optional(),
});
export type AgentProfileSummary = z.infer<typeof AgentProfileSummarySchema>;

const AgentProfilesStateSchema = z.object({
    daemonPid: z.number(),
    updatedAt: z.number(),
    accounts: z.array(z.unknown()),
    defaults: z.record(z.string(), z.unknown()),
    /** Not in v1: kinds this daemon can add. Absent = the v1 set (claude-subscription, claude-api). */
    kinds: z.array(z.string()).optional(),
});

export interface AgentProfilesState {
    daemonPid: number;
    updatedAt: number;
    accounts: AgentProfileSummary[];
    /** agent → account id new sessions use when the spawn names none; absent = machine login. */
    defaults: Record<string, string>;
    kinds: string[];
}

const V1_KINDS = ['claude-subscription', 'claude-api'];

/** Accounts list: one malformed entry is dropped, never the whole list. */
export function parseAgentProfilesState(raw: unknown): AgentProfilesState | null {
    const parsed = AgentProfilesStateSchema.safeParse(raw);
    if (!parsed.success) return null;
    const accounts: AgentProfileSummary[] = [];
    for (const entry of parsed.data.accounts) {
        const account = AgentProfileSummarySchema.safeParse(entry);
        if (account.success) accounts.push(account.data);
    }
    const defaults: Record<string, string> = {};
    for (const [agent, id] of Object.entries(parsed.data.defaults)) if (typeof id === 'string' && id) defaults[agent] = id;
    return { daemonPid: parsed.data.daemonPid, updatedAt: parsed.data.updatedAt, accounts, defaults, kinds: parsed.data.kinds ?? V1_KINDS };
}

/**
 * Machine capability: `daemonState.agentProfiles` written by the CURRENT daemon
 * run (`daemonPid === daemonState.pid`). daemonState survives daemon restarts on
 * the server, so a stale copy from a newer CLI that was downgraded must not
 * light up the account UI. null = old CLI → 「本机登录 · 升级 CLI」 only.
 */
export function readMachineAgentProfiles(machine: { daemonState?: unknown } | null | undefined): AgentProfilesState | null {
    const daemonState = machine?.daemonState;
    if (!daemonState || typeof daemonState !== 'object') return null;
    const state = parseAgentProfilesState((daemonState as { agentProfiles?: unknown }).agentProfiles);
    if (!state) return null;
    const pid = (daemonState as { pid?: unknown }).pid;
    return typeof pid === 'number' && state.daemonPid === pid ? state : null;
}

export type SessionAgentProfile = {
    id: string;
    label: string;
    kind: string;
    /** 'active' | 'unavailable' (unknown → 'active': the wrapper did not refuse) */
    status: 'active' | 'unavailable';
    reason?: string;
    model?: string;
};

/**
 * `metadata.agentProfile` (what the wrapper ACTUALLY runs on):
 * undefined = old wrapper (or unreadable), null = machine login, object = account.
 */
export function readSessionAgentProfile(value: unknown): SessionAgentProfile | null | undefined {
    if (value === null) return null;
    if (!value || typeof value !== 'object') return undefined;
    const v = value as Record<string, unknown>;
    if (typeof v.id !== 'string' || typeof v.label !== 'string' || typeof v.kind !== 'string') return undefined;
    return {
        id: v.id,
        label: v.label,
        kind: v.kind,
        status: v.status === 'unavailable' ? 'unavailable' : 'active',
        ...(typeof v.reason === 'string' ? { reason: v.reason } : {}),
        ...(typeof v.model === 'string' && v.model ? { model: v.model } : {}),
    };
}

export function sessionSupportsAgentProfiles(metadata: { capabilities?: readonly string[] | null } | null | undefined): boolean {
    return metadata?.capabilities?.includes(AGENT_PROFILE_SESSION_CAPABILITY) === true;
}

export function agentHasAccounts(agent: string | null | undefined): boolean {
    return (ACCOUNT_AGENTS as readonly string[]).includes(agent ?? 'claude');
}

// ---- presentation (pure) ----

/** Q1 type tags: 订阅 / API / 本机供应商. */
export type AccountKindTag = 'subscription' | 'api' | 'local-provider';

export function accountKindTag(kind: string): AccountKindTag {
    if (kind === 'claude-subscription' || kind === 'codex-chatgpt') return 'subscription';
    if (kind === 'codex-provider' || kind === 'pi-provider') return 'local-provider';
    return 'api';
}

export function isApiAccount(kind: string | null | undefined): boolean {
    return !!kind && accountKindTag(kind) === 'api';
}

/** 「即将过期」 window for subscription tokens (design F6: a reminder, not a block). */
export const ACCOUNT_EXPIRING_MS = 30 * 24 * 60 * 60 * 1000;

/** Status the UI shows: the daemon's (whitelisted) plus the derived 'expiring'. */
export type AccountDisplayStatus = 'ok' | 'expiring' | 'unverified' | 'expired' | 'invalid' | 'missing-secret';

export function accountDisplayStatus(account: Pick<AgentProfileSummary, 'status' | 'expiresAt'>, now = Date.now()): AccountDisplayStatus {
    const status = account.status;
    if (status === 'expired' || status === 'invalid' || status === 'missing-secret') return status;
    if (account.expiresAt !== undefined && account.expiresAt <= now) return 'expired';
    const base: AccountDisplayStatus = status === 'ok' ? 'ok' : 'unverified';
    if (account.expiresAt !== undefined && account.expiresAt - now <= ACCOUNT_EXPIRING_MS) return 'expiring';
    return base;
}

/** Can a turn run on it? 'unverified' (never checked / network) and 'expiring' can. */
export function accountUsable(status: AccountDisplayStatus): boolean {
    return status === 'ok' || status === 'expiring' || status === 'unverified';
}

export type AccountTone = 'live' | 'warn' | 'err' | 'muted';

export function accountStatusTone(status: AccountDisplayStatus): AccountTone {
    switch (status) {
        case 'ok': return 'live';
        case 'expiring': return 'warn';
        case 'unverified': return 'muted';
        default: return 'err';
    }
}

/** Days left before a subscription token expires (ceil; 0 = today). */
export function daysUntil(expiresAt: number, now = Date.now()): number {
    return Math.max(0, Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000)));
}

/** Re-login fixes an expired / rejected subscription; an API account needs its key fixed. */
export function accountNeedsRelogin(kind: string, status: AccountDisplayStatus | string): boolean {
    return accountKindTag(kind) === 'subscription' && (status === 'expired' || status === 'invalid' || status === 'missing-secret' || status === 'expiring');
}

export function accountsForAgent(state: AgentProfilesState | null, agent: string): AgentProfileSummary[] {
    return state ? state.accounts.filter((account) => account.agent === agent) : [];
}

// ---- new session: which account a spawn will use (Q3) ----

/**
 * The draft's choice: undefined = not chosen (the machine's default for the
 * agent applies), null = machine login, string = that account.
 */
export type SpawnAccountChoice = string | null | undefined;

export type SpawnAccountResolution =
    /** old CLI / agent without accounts: send nothing, the machine login runs */
    | { kind: 'unsupported' }
    | { kind: 'machine'; explicit: boolean }
    | { kind: 'account'; account: AgentProfileSummary; status: AccountDisplayStatus; fromDefault: boolean }
    /** Q3: stop before creating — the user must pick another. */
    | { kind: 'blocked'; reason: 'missing' | 'expired' | 'invalid' | 'missing-secret'; label: string | null; fromDefault: boolean };

export function resolveSpawnAccount(state: AgentProfilesState | null, agent: string, choice: SpawnAccountChoice, now = Date.now()): SpawnAccountResolution {
    if (!state || !agentHasAccounts(agent)) return { kind: 'unsupported' };
    if (choice === null) return { kind: 'machine', explicit: true };
    const fromDefault = choice === undefined;
    const id = fromDefault ? state.defaults[agent] : choice;
    if (!id) return { kind: 'machine', explicit: false };
    const account = state.accounts.find((a) => a.id === id && a.agent === agent);
    if (!account) return { kind: 'blocked', reason: 'missing', label: null, fromDefault };
    const status = accountDisplayStatus(account, now);
    if (!accountUsable(status)) return { kind: 'blocked', reason: status as 'expired' | 'invalid' | 'missing-secret', label: account.label, fromDefault };
    return { kind: 'account', account, status, fromDefault };
}

/**
 * The `agentProfileId` spawn param. Only an explicit choice is sent (undefined
 * lets the daemon apply its own default, same as an old Web), and never to an
 * old CLI or an agent without accounts (the daemon rejects a non-Claude id).
 */
export function spawnAgentProfileParam(state: AgentProfilesState | null, agent: string, choice: SpawnAccountChoice): { agentProfileId?: string | null } {
    if (!state || !agentHasAccounts(agent) || choice === undefined) return {};
    return { agentProfileId: choice };
}

/** `agent-profile-unavailable:<reason>` from a spawn (the daemon's own Q3 refusal). */
export function parseSpawnAccountError(message: string | null | undefined): string | null {
    const match = /agent-profile-unavailable:([a-z-]+)/.exec(message ?? '');
    return match ? match[1] : null;
}

// ---- API account model list ----

/** API kinds: the account's models (first = default); the session's pinned model is kept even if not listed. */
export function apiAccountModels(account: Pick<AgentProfileSummary, 'models'> | null | undefined, pinned: string | null | undefined): string[] {
    const models = (account?.models ?? []).filter(Boolean);
    return pinned && !models.includes(pinned) ? [pinned, ...models] : models;
}

/** Split the add form's model field: one per line or comma-separated, deduped, order kept. */
export function parseModelList(text: string): string[] {
    const out: string[] = [];
    for (const part of text.split(/[\n,]+/)) {
        const id = part.trim();
        if (id && !out.includes(id)) out.push(id);
    }
    return out;
}

export function isValidBaseUrl(text: string): boolean {
    return /^https?:\/\/\S+$/.test(text.trim()) && text.trim().length <= 512;
}

export function isValidEnvName(text: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(text.trim());
}

export function baseUrlHost(baseUrl: string | undefined): string | null {
    if (!baseUrl) return null;
    try { return new URL(baseUrl).host || null; } catch { return null; }
}

// ---- login (subscription) ----

export type LoginState = 'waiting-code' | 'exchanging' | 'succeeded' | 'failed' | 'canceled' | 'expired';
const LOGIN_STATES: ReadonlySet<string> = new Set(['waiting-code', 'exchanging', 'succeeded', 'failed', 'canceled', 'expired']);

export interface LoginStatus {
    loginId: string;
    /** unknown → 'failed' would end polling on a newer CLI's new state; keep polling instead ('exchanging'). */
    state: LoginState;
    url?: string;
    expiresAt?: number;
    account?: AgentProfileSummary;
    error?: string;
}

export function parseLoginStatus(raw: unknown): LoginStatus | null {
    if (!raw || typeof raw !== 'object') return null;
    const v = raw as Record<string, unknown>;
    if (typeof v.loginId !== 'string' || typeof v.state !== 'string') return null;
    const account = AgentProfileSummarySchema.safeParse(v.account);
    return {
        loginId: v.loginId,
        state: LOGIN_STATES.has(v.state) ? v.state as LoginState : 'exchanging',
        ...(typeof v.url === 'string' && /^https:\/\//.test(v.url) ? { url: v.url } : {}),
        ...(typeof v.expiresAt === 'number' ? { expiresAt: v.expiresAt } : {}),
        ...(account.success ? { account: account.data } : {}),
        ...(typeof v.error === 'string' ? { error: v.error } : {}),
    };
}

export function isLoginTerminal(state: LoginState): boolean {
    return state === 'succeeded' || state === 'failed' || state === 'canceled' || state === 'expired';
}

/** Web polls every 1–2 s until a terminal state (contract). */
export const LOGIN_POLL_MS = 1500;

// ---- session switch (bind) ----

export interface SwitchPlan {
    /** null = back to the machine login */
    accountId: string | null;
    label: string | null;
    /** Different organization / endpoint → the first turn misses the prompt cache. */
    cacheMiss: boolean;
    /** API kinds: the model the session will be pinned to. */
    model?: string;
}

/** What the confirm dialog says for switching `current` → `target`. */
export function planAccountSwitch(current: SessionAgentProfile | null | undefined, target: AgentProfileSummary | null, model?: string): SwitchPlan {
    const currentId = current ? current.id : null;
    const targetId = target ? target.id : null;
    const pinned = target && isApiAccount(target.kind) ? (model ?? target.models?.[0]) : undefined;
    return {
        accountId: targetId,
        label: target ? target.label : null,
        cacheMiss: currentId !== targetId,
        ...(pinned ? { model: pinned } : {}),
    };
}
