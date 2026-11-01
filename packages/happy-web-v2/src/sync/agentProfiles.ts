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
import {
    AGENT_PROFILE_RPC,
    AGENT_PROFILE_SESSION_CAPABILITY,
    AgentProfileSummarySchema,
    readSessionAgentProfile as readWireSessionAgentProfile,
    type AgentProfileSummary,
} from '@slopus/happy-wire';

// Contract (B-850a wire v1 + v2) comes from happy-wire; this module adds the
// Web's trust gate, whitelisted reads, presentation and Q3 decisions.
export { AGENT_PROFILE_RPC, AGENT_PROFILE_SESSION_CAPABILITY, AgentProfileSummarySchema, type AgentProfileSummary };

/** Agents that have accounts in this release (B-850c2: codex; pi/gemini come with PR-G). */
export const ACCOUNT_AGENTS = ['claude', 'codex'] as const;

/** The kinds each agent's accounts can be (add form order). */
export const AGENT_ACCOUNT_KINDS: Record<string, readonly string[]> = {
    claude: ['claude-subscription', 'claude-api'],
    codex: ['codex-chatgpt', 'codex-provider'],
};

/** B-850b `codexProviders`: the machine's ~/.codex/config.toml providers (no secrets). */
export type CodexProviderOption = { id: string; name?: string; baseUrl?: string; envKey?: string };

const AgentProfilesStateSchema = z.object({
    daemonPid: z.number(),
    updatedAt: z.number(),
    accounts: z.array(z.unknown()),
    defaults: z.record(z.string(), z.unknown()),
    /** Not in v1: kinds this daemon can add. Absent = the v1 set (claude-subscription, claude-api). */
    kinds: z.array(z.string()).optional(),
    /** Wire v3 (B-850b). */
    codexProviders: z.array(z.unknown()).optional(),
});

export interface AgentProfilesState {
    daemonPid: number;
    updatedAt: number;
    accounts: AgentProfileSummary[];
    /** agent → account id new sessions use when the spawn names none; absent = machine login. */
    defaults: Record<string, string>;
    kinds: string[];
    /** Wire v3: for the codex-provider add form. Empty on an older CLI / a config.toml without providers. */
    codexProviders: CodexProviderOption[];
}

const V1_KINDS = ['claude-subscription', 'claude-api'];
const CODEX_KINDS = ['codex-chatgpt', 'codex-provider'];

function readCodexProvider(raw: unknown): CodexProviderOption | null {
    if (!raw || typeof raw !== 'object') return null;
    const v = raw as Record<string, unknown>;
    if (typeof v.id !== 'string' || !v.id) return null;
    return {
        id: v.id,
        ...(typeof v.name === 'string' && v.name ? { name: v.name } : {}),
        ...(typeof v.baseUrl === 'string' && v.baseUrl ? { baseUrl: v.baseUrl } : {}),
        ...(typeof v.envKey === 'string' && v.envKey ? { envKey: v.envKey } : {}),
    };
}

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
    const codexProviders = (parsed.data.codexProviders ?? []).map(readCodexProvider).filter((p): p is CodexProviderOption => !!p);
    // Wire v3 publishes no `kinds`: a B-850b daemon shows itself by its Codex parts
    // (codexProviders, a Codex account or default). A B-850a daemon has none of them
    // and rejects Codex adds, so its Codex section stays 「本机登录 · 升级 CLI」.
    const codexEvidence = parsed.data.codexProviders !== undefined || accounts.some((a) => a.agent === 'codex') || !!defaults.codex;
    const kinds = parsed.data.kinds ?? (codexEvidence ? [...V1_KINDS, ...CODEX_KINDS] : V1_KINDS);
    return { daemonPid: parsed.data.daemonPid, updatedAt: parsed.data.updatedAt, accounts, defaults, kinds, codexProviders };
}

/** Does this daemon serve accounts for `agent` (it can add at least one of its kinds)? */
export function machineHasAgentAccounts(state: AgentProfilesState | null, agent: string): boolean {
    if (!state) return false;
    return (AGENT_ACCOUNT_KINDS[agent] ?? []).some((kind) => state.kinds.includes(kind));
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
    const raw = readWireSessionAgentProfile(value);
    if (!raw) return raw;
    return {
        id: raw.id,
        label: raw.label,
        kind: raw.kind,
        status: raw.status === 'unavailable' ? 'unavailable' : 'active',
        ...(raw.reason !== undefined ? { reason: raw.reason } : {}),
        ...(raw.model ? { model: raw.model } : {}),
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
    if (!state || !agentHasAccounts(agent) || !machineHasAgentAccounts(state, agent)) return { kind: 'unsupported' };
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
 * old CLI or an agent this daemon has no accounts for (a B-850a daemon rejects a Codex id).
 */
export function spawnAgentProfileParam(state: AgentProfilesState | null, agent: string, choice: SpawnAccountChoice): { agentProfileId?: string | null } {
    if (!state || !agentHasAccounts(agent) || !machineHasAgentAccounts(state, agent) || choice === undefined) return {};
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

/** 'starting' (wire v2): the machine is still launching setup-token / the Codex app-server — a waiting state. */
export type LoginState = 'starting' | 'waiting-code' | 'exchanging' | 'succeeded' | 'failed' | 'canceled' | 'expired';
const LOGIN_STATES: ReadonlySet<string> = new Set(['starting', 'waiting-code', 'exchanging', 'succeeded', 'failed', 'canceled', 'expired']);

export interface LoginStatus {
    loginId: string;
    /** unknown → 'failed' would end polling on a newer CLI's new state; keep polling instead ('exchanging'). */
    state: LoginState;
    /** Wire v3: 'device-code' (Codex: open `url`, enter `userCode`, nothing to paste) | 'paste-code' (Claude; also when absent). */
    flow: 'paste-code' | 'device-code';
    userCode?: string;
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
        flow: v.flow === 'device-code' ? 'device-code' : 'paste-code',
        ...(typeof v.userCode === 'string' && v.userCode.trim() ? { userCode: v.userCode.trim() } : {}),
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

/**
 * Wire v2: bind may answer restart 'pending' (the daemon is still restarting
 * after ~22 s). The switch is done once the wrapper reports the target in
 * `metadata.agentProfile` (null target = machine login).
 */
export function switchLanded(profile: SessionAgentProfile | null | undefined, targetId: string | null): boolean {
    if (profile === undefined) return false;
    return (profile ? profile.id : null) === targetId;
}

export interface SwitchPlan {
    /** null = back to the machine login */
    accountId: string | null;
    label: string | null;
    /** Different organization / endpoint → the first turn misses the prompt cache. */
    cacheMiss: boolean;
    /** API kinds: the model the session will be pinned to. */
    model?: string;
    /**
     * Codex, wire v3: ChatGPT ↔ API provider ↔ machine login. Allowed, but the
     * new account may refuse the old history (`agent-profile-history-rejected`).
     */
    crossType: boolean;
}

/** Codex account families for the cross-type warning; the machine login is its own (config.toml decides). */
function codexFamily(kind: string | null): 'chatgpt' | 'provider' | 'machine' {
    if (kind === null) return 'machine';
    return kind === 'codex-chatgpt' ? 'chatgpt' : 'provider';
}

/** What the confirm dialog says for switching `current` → `target`. */
export function planAccountSwitch(current: SessionAgentProfile | null | undefined, target: AgentProfileSummary | null, model?: string, agent = 'claude'): SwitchPlan {
    const currentId = current ? current.id : null;
    const targetId = target ? target.id : null;
    const pinned = target && isApiAccount(target.kind) ? (model ?? target.models?.[0]) : undefined;
    return {
        accountId: targetId,
        label: target ? target.label : null,
        cacheMiss: currentId !== targetId,
        crossType: agent === 'codex' && currentId !== targetId && codexFamily(current ? current.kind : null) !== codexFamily(target ? target.kind : null),
        ...(pinned ? { model: pinned } : {}),
    };
}

// ---- add form (codex-provider, wire v3) ----

export interface CodexProviderForm {
    label: string;
    /** a `codexProviders` id, or null = own URL */
    provider: string | null;
    baseUrl: string;
    wireApi: 'responses' | 'chat';
    models: string;
}

/**
 * The `agent-profile-add` fields for a Codex provider, or null while the form
 * cannot be sent. A config.toml provider brings its own base_url / wire_api
 * (the URL field then only overrides); an own URL needs a valid URL and says
 * its wire API.
 */
export function codexProviderAddFields(form: CodexProviderForm): { label: string; provider?: string; baseUrl?: string; wireApi?: 'responses' | 'chat'; models: string[] } | null {
    const label = form.label.trim();
    const baseUrl = form.baseUrl.trim();
    if (!label) return null;
    if (baseUrl && !isValidBaseUrl(baseUrl)) return null;
    if (!form.provider && !baseUrl) return null;
    return {
        label,
        ...(form.provider ? { provider: form.provider } : { wireApi: form.wireApi }),
        ...(baseUrl ? { baseUrl } : {}),
        models: parseModelList(form.models),
    };
}

/** 「你@例子.com · Plus」 for a ChatGPT account; an API provider shows which config.toml provider it is based on. */
export function codexAccountFacts(account: Pick<AgentProfileSummary, 'kind' | 'email' | 'planType' | 'provider'>): { email?: string; plan?: string; provider?: string } {
    if (account.kind === 'codex-chatgpt') return { ...(account.email ? { email: account.email } : {}), ...(account.planType ? { plan: account.planType } : {}) };
    if (account.kind === 'codex-provider' && account.provider) return { provider: account.provider };
    return {};
}
