/**
 * B-850a: account operations shared by the daemon RPCs (Web) and
 * `very-happy account` (terminal). Files are the source of truth (store.ts);
 * the daemon republishes `daemonState.agentProfiles` after every change.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    AgentProfileAddRequestSchema,
    AgentProfileBindRequestSchema,
    AgentProfileLoginStartRequestSchema,
    AgentProfileLoginSubmitRequestSchema,
    type AgentProfileBindResult,
    type AgentProfileLoginStatus,
    type AgentProfileSummary,
    type AgentProfilesState,
} from '@slopus/happy-wire';
import { checkApiAccount, checkSubscriptionAccount } from './checkAccount';
import { SetupTokenLoginManager, type SpawnPty } from './setupTokenLogin';
import { baseCodexHome, readCodexProviders } from './codexConfig';
import { syncCodexOverlay } from './codexHome';
import { CodexDeviceLoginManager, checkCodexChatgptAccount, checkCodexProviderAccount, spawnCodexRpc, type SpawnCodexRpc } from './codexLogin';
import {
    SUBSCRIPTION_TOKEN_TTL_MS,
    accountCodexHomePath,
    accountSecretPath,
    buildAgentProfilesState,
    defaultSecretProbe,
    expandHome,
    newAccountId,
    readAccounts,
    readAccountsFileV2,
    readSessionBindingV2,
    readSessionBindings,
    removeAccountSecret,
    sessionsBoundTo,
    summarizeAccount,
    writeAccountSecret,
    writeAccountsFile,
    writeSessionBinding,
    type AccountCheck,
    type AccountRecord,
} from './store';

const ACCOUNT_AGENTS = ['claude', 'codex'] as const;

export class AccountError extends Error {
    constructor(readonly code: string, message: string, readonly sessions?: string[]) {
        super(message);
    }
}

/** `stillRunning`: the restart failed and the session's old wrapper is alive (on the old credential). */
export type RestartOutcome = { ok: true } | { ok: false; notRunning?: boolean; stillRunning?: boolean; error: string };

/** controlClient's messages when no daemon answers: nothing of this machine is running. */
const DAEMON_DOWN = /^(No daemon running|Daemon is not running)/;

/**
 * A failed restart through the local daemon (`account bind`, `session provider`).
 * `notRunning` only for the daemon's own `restart-precheck:not-tracked` or no
 * daemon at all — never a loose match on the text (QA30: "restart-limit … this
 * daemon session" read as not running, so bind kept a binding the live wrapper
 * ignored). A wrapper still running always wins.
 */
export function localRestartFailure(error: string, stillRunning: boolean): Extract<RestartOutcome, { ok: false }> {
    return { ok: false, stillRunning, notRunning: !stillRunning && (error.startsWith('restart-precheck:not-tracked') || DAEMON_DOWN.test(error)), error };
}

/** What `account bind` / `session provider` print, and the exit code (non-zero whenever the switch did not happen as asked). */
export function bindResultMessages(result: AgentProfileBindResult, sessionId: string, target: string, noun: 'account' | 'provider'): { out: string[]; err: string[]; exitCode: 0 | 1 } {
    const bound = `Bound ${sessionId} → ${target}.`;
    if (result.restart === 'done') return { out: [bound, 'Restarted in place (history kept).'], err: [], exitCode: 0 };
    if (result.restart === 'pending') return { out: [bound, 'Restart in progress.'], err: [], exitCode: 0 };
    if (result.restart === 'skipped') return { out: [bound, `Not restarted${result.error ? ` (${result.error})` : ''}; applies when the session next starts.`], err: [], exitCode: 0 };
    if (result.rolledBack) return { out: [], err: [`Not switched: the restart failed (${result.error}). The session keeps running on its previous ${noun}; the binding was not changed.`], exitCode: 1 };
    return { out: [], err: [`Binding to ${target} saved, but the restart failed (${result.error}); the session is not running and starts on ${target} next time.`], exitCode: 1 };
}

export type AccountServiceDeps = {
    home: string;
    env?: Record<string, string | undefined>;
    now?: () => number;
    daemonPid?: number;
    spawnPty?: SpawnPty;
    /** B-850b: `codex app-server` for ChatGPT sign-in / checks (test seam). */
    spawnCodexRpc?: SpawnCodexRpc;
    restartSession?: (sessionId: string) => Promise<RestartOutcome>;
    /** Called after every write so the daemon can republish its state. */
    onChanged?: () => void;
    /** B-850b: the agent a session runs (from its tracked flavor); unknown → no check. */
    sessionAgent?: (sessionId: string) => string | null | undefined;
    /** Test seam for the 1-token checks. */
    check?: (record: AccountRecord, secret: string) => Promise<AccountCheck>;
};

/** Relay RPCs cap at 30 s (AGENTS #17); leave room for the round trip. */
export const BIND_RESTART_BUDGET_MS = 22_000;

export class AccountService {
    private readonly home: string;
    private readonly env: Record<string, string | undefined>;
    private readonly now: () => number;
    private logins: SetupTokenLoginManager | null = null;
    private codexLogins: CodexDeviceLoginManager | null = null;
    /** loginId → account to (re)write when its token arrives. */
    private readonly loginTargets = new Map<string, { accountId?: string; label?: string }>();

    constructor(private readonly deps: AccountServiceDeps) {
        this.home = deps.home;
        this.env = deps.env ?? process.env;
        this.now = deps.now ?? Date.now;
    }

    state(): AgentProfilesState {
        const state = buildAgentProfilesState(this.home, readAccounts(this.home), defaultSecretProbe(this.env), this.now(), this.deps.daemonPid ?? process.pid);
        // B-850b: what a codex-provider account can be based on (no secrets: env_key is a variable name).
        const codexProviders = readCodexProviders(this.env).map((p) => ({ id: p.id, ...(p.name ? { name: p.name } : {}), ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}), ...(p.envKey ? { envKey: p.envKey } : {}) }));
        return codexProviders.length > 0 ? { ...state, codexProviders } : state;
    }

    private summary(id: string): AgentProfileSummary {
        const record = readAccounts(this.home).accounts[id];
        if (!record) throw new AccountError('not-found', `no account "${id}"`);
        return summarizeAccount(this.home, id, record, defaultSecretProbe(this.env), this.now());
    }

    private changed(): void {
        try { this.deps.onChanged?.(); } catch { /* publishing is best-effort */ }
    }

    private editable(id: string): { file: ReturnType<typeof readAccountsFileV2>; record: AccountRecord } {
        const file = readAccountsFileV2(this.home);
        const record = file.accounts[id];
        if (!record) {
            if (readAccounts(this.home).accounts[id]?.legacy) throw new AccountError('legacy-readonly', `"${id}" comes from providers.json; edit or remove it there`);
            throw new AccountError('not-found', `no account "${id}"`);
        }
        return { file, record };
    }

    // ---- add / edit -----------------------------------------------------------

    async add(params: unknown): Promise<AgentProfileSummary> {
        const parsed = AgentProfileAddRequestSchema.safeParse(params);
        if (!parsed.success) throw new AccountError('invalid-params', parsed.error.issues[0]?.message ?? 'invalid params');
        const req = parsed.data;
        if (req.agent === 'codex' && req.provider && !readCodexProviders(this.env).some((p) => p.id === req.provider)) {
            throw new AccountError('not-found', `no [model_providers.${req.provider}] in the machine's Codex config.toml`);
        }
        const file = readAccountsFileV2(this.home);
        const id = newAccountId(req.label, req.kind, Object.keys(readAccounts(this.home).accounts));
        const models: string[] = [];
        const contextWindows: Record<string, number> = {};
        for (const m of req.models ?? []) {
            if (typeof m === 'string') models.push(m);
            else {
                models.push(m.id);
                if (m.contextWindow) contextWindows[m.id] = m.contextWindow;
            }
        }
        const record: AccountRecord = {
            label: req.label,
            agent: req.agent,
            kind: req.kind,
            createdAt: this.now(),
            ...(req.baseUrl ? { baseUrl: req.baseUrl.replace(/\/+$/, '') } : {}),
            ...(req.agent === 'codex' && req.provider ? { provider: req.provider } : {}),
            ...(req.agent === 'codex' && req.wireApi ? { wireApi: req.wireApi } : {}),
            key: req.key.source === 'paste' ? { source: 'stored' } : req.key.source === 'file' ? { source: 'file', path: req.key.path } : { source: 'env', name: req.key.name },
            ...(models.length > 0 ? { models } : {}),
            ...(Object.keys(contextWindows).length > 0 ? { contextWindows } : {}),
        };
        if (req.key.source === 'paste') writeAccountSecret(this.home, id, req.key.value);
        file.accounts[id] = record;
        writeAccountsFile(this.home, file);
        this.changed();
        return this.test(id);
    }

    rename(accountId: unknown, label: unknown): AgentProfileSummary {
        if (typeof accountId !== 'string' || typeof label !== 'string' || !label.trim() || label.trim().length > 60) {
            throw new AccountError('invalid-params', 'accountId and a 1–60 character label are required');
        }
        const { file, record } = this.editable(accountId);
        record.label = label.trim();
        writeAccountsFile(this.home, file);
        this.changed();
        return this.summary(accountId);
    }

    /**
     * `force` with bound sessions: the credential is gone, so each of those
     * sessions restarts in place right away and comes back `unavailable`
     * (refusing turns, Q3) instead of running on the deleted credential until
     * its next start. Restarts run in parallel within the bind budget; one
     * still going reports 'pending'.
     */
    async remove(accountId: unknown, force: unknown): Promise<{ removed: true; sessions: string[]; restarts?: Record<string, string> }> {
        if (typeof accountId !== 'string') throw new AccountError('invalid-params', 'accountId is required');
        const { file } = this.editable(accountId);
        const sessions = sessionsBoundTo(readSessionBindings(this.home), accountId);
        if (sessions.length > 0 && force !== true) {
            throw new AccountError('in-use', `${sessions.length} session(s) use this account; switch them first or remove with force`, sessions);
        }
        delete file.accounts[accountId];
        for (const [agent, id] of Object.entries(file.defaults)) if (id === accountId) delete file.defaults[agent];
        writeAccountsFile(this.home, file);
        removeAccountSecret(this.home, accountId);
        this.changed();
        if (sessions.length === 0 || !this.deps.restartSession) return { removed: true, sessions };
        const restarts: Record<string, string> = {};
        await Promise.all(sessions.map(async (sessionId) => { restarts[sessionId] = await this.restartWithinBudget(sessionId); }));
        return { removed: true, sessions, restarts };
    }

    /** 'done' | 'skipped' (not running here) | 'pending' (still going after the budget) | 'failed' */
    private async restartWithinBudget(sessionId: string): Promise<string> {
        const outcome = await Promise.race([
            this.deps.restartSession!(sessionId),
            new Promise<'pending'>((r) => setTimeout(() => r('pending'), BIND_RESTART_BUDGET_MS).unref?.()),
        ]);
        if (outcome === 'pending') return 'pending';
        if (outcome.ok) return 'done';
        return outcome.notRunning ? 'skipped' : 'failed';
    }

    setDefault(agent: unknown, accountId: unknown): AgentProfilesState {
        if (!ACCOUNT_AGENTS.includes(agent as never)) throw new AccountError('invalid-params', 'agent must be "claude" or "codex"');
        if (accountId !== null && typeof accountId !== 'string') throw new AccountError('invalid-params', 'accountId must be a string or null');
        if (typeof accountId === 'string') {
            const record = readAccounts(this.home).accounts[accountId];
            if (!record) throw new AccountError('not-found', `no account "${accountId}"`);
            if (record.agent !== agent) throw new AccountError('invalid-params', `"${accountId}" is not a ${agent} account`);
        }
        const file = readAccountsFileV2(this.home);
        if (accountId === null) delete file.defaults[agent as string];
        else file.defaults[agent as string] = accountId;
        writeAccountsFile(this.home, file);
        this.changed();
        return this.state();
    }

    // ---- check ---------------------------------------------------------------

    private readSecretFor(id: string, record: AccountRecord): string | null {
        try {
            if (record.kind === 'claude-subscription' || record.key?.source === 'stored') return readFileSync(accountSecretPath(this.home, id), 'utf8').trim() || null;
            if (record.key?.source === 'file') return readFileSync(expandHome(record.key.path), 'utf8').trim() || null;
            if (record.key?.source === 'env') return this.env[record.key.name]?.trim() || null;
        } catch {
            return null;
        }
        return null;
    }

    async test(accountId: unknown): Promise<AgentProfileSummary> {
        if (typeof accountId !== 'string') throw new AccountError('invalid-params', 'accountId is required');
        const record = readAccounts(this.home).accounts[accountId];
        if (!record) throw new AccountError('not-found', `no account "${accountId}"`);
        let check: AccountCheck;
        if (record.kind === 'codex-chatgpt') {
            if (this.summary(accountId).status === 'missing-secret') return this.summary(accountId);
            const codexHome = accountCodexHomePath(this.home, accountId);
            syncCodexOverlay(codexHome, baseCodexHome(this.env), this.now());
            check = this.deps.check
                ? await this.deps.check(record, '')
                : await checkCodexChatgptAccount(codexHome, this.env, this.deps.spawnCodexRpc ?? spawnCodexRpc, this.now);
        } else {
            const secret = this.readSecretFor(accountId, record);
            if (!secret) return this.summary(accountId);
            check = this.deps.check
                ? await this.deps.check(record, secret)
                : record.kind === 'claude-subscription'
                    ? await checkSubscriptionAccount(secret, join(this.home, 'tmp', 'account-check'), this.now)
                    : record.kind === 'codex-provider'
                        ? await this.checkCodexProvider(record, secret)
                        : await checkApiAccount(record, secret, this.now);
        }
        // Legacy (providers.json) accounts are read-only: report, do not persist.
        if (!record.legacy) {
            const file = readAccountsFileV2(this.home);
            if (file.accounts[accountId]) {
                file.accounts[accountId].check = check;
                writeAccountsFile(this.home, file);
                this.changed();
            }
            return this.summary(accountId);
        }
        return { ...this.summary(accountId), status: check.status, checkedAt: check.at, ...(check.detail ? { statusDetail: check.detail } : {}) };
    }

    private async checkCodexProvider(record: AccountRecord, secret: string): Promise<AccountCheck> {
        const base = record.provider ? readCodexProviders(this.env).find((p) => p.id === record.provider) : undefined;
        const baseUrl = record.baseUrl ?? base?.baseUrl;
        if (!baseUrl) return { status: 'unverified', at: this.now(), detail: `provider "${record.provider}" is not in the machine's Codex config.toml` };
        const headers: Record<string, string> = {};
        const raw = base?.table.http_headers;
        if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'string') headers[k] = v;
        return checkCodexProviderAccount(baseUrl, secret, headers, this.now);
    }

    // ---- remote login (claude setup-token) -------------------------------------

    private loginManager(): SetupTokenLoginManager {
        if (this.logins) return this.logins;
        const spawnPty = this.deps.spawnPty;
        if (!spawnPty) throw new AccountError('internal', 'remote login is not available in this process');
        this.logins = new SetupTokenLoginManager({
            spawnPty,
            env: this.env,
            newId: () => randomUUID(),
            now: this.now,
            onToken: async (loginId, token) => {
                const target = this.loginTargets.get(loginId) ?? {};
                this.loginTargets.delete(loginId);
                return this.storeSubscriptionToken(token, target);
            },
        });
        return this.logins;
    }

    /** Also the terminal path (`very-happy account login`). */
    storeSubscriptionToken(token: string, target: { accountId?: string; label?: string }): AgentProfileSummary {
        const file = readAccountsFileV2(this.home);
        const now = this.now();
        let id = target.accountId;
        if (id) {
            const record = file.accounts[id];
            if (!record || record.kind !== 'claude-subscription') throw new AccountError('not-found', `no subscription account "${id}"`);
            record.expiresAt = now + SUBSCRIPTION_TOKEN_TTL_MS;
            record.check = { status: 'ok', at: now };
        } else {
            const label = target.label?.trim() || 'Claude';
            id = newAccountId(label, 'claude-subscription', Object.keys(readAccounts(this.home).accounts));
            file.accounts[id] = { label, agent: 'claude', kind: 'claude-subscription', createdAt: now, expiresAt: now + SUBSCRIPTION_TOKEN_TTL_MS, check: { status: 'ok', at: now } };
        }
        writeAccountSecret(this.home, id, token);
        writeAccountsFile(this.home, file);
        this.changed();
        return this.summary(id);
    }

    async loginStart(params: unknown): Promise<AgentProfileLoginStatus> {
        const parsed = AgentProfileLoginStartRequestSchema.safeParse(params);
        if (!parsed.success) throw new AccountError('invalid-params', parsed.error.issues[0]?.message ?? 'invalid params');
        if (parsed.data.agent === 'codex') return this.codexLoginStart(parsed.data.accountId, parsed.data.label);
        const { accountId, label } = parsed.data;
        if (accountId) {
            const record = readAccounts(this.home).accounts[accountId];
            if (!record || record.kind !== 'claude-subscription') throw new AccountError('not-found', `no subscription account "${accountId}"`);
        } else if (!label) {
            throw new AccountError('invalid-params', 'label is required for a new account');
        }
        let status: AgentProfileLoginStatus;
        try {
            status = await this.loginManager().start();
        } catch (error) {
            const code = (error as { code?: string }).code ?? 'setup-token-failed';
            throw new AccountError(code, error instanceof Error ? error.message : String(error));
        }
        this.loginTargets.set(status.loginId, { accountId, label });
        return { ...status, flow: 'paste-code' };
    }

    // ---- remote login (Codex ChatGPT device code) — B-850b ----------------------

    private codexLoginManager(): CodexDeviceLoginManager {
        if (this.codexLogins) return this.codexLogins;
        this.codexLogins = new CodexDeviceLoginManager({
            spawnRpc: this.deps.spawnCodexRpc ?? spawnCodexRpc,
            env: this.env,
            newId: () => randomUUID(),
            now: this.now,
            onSuccess: async (loginId, info) => {
                const target = this.codexLoginTargets.get(loginId);
                this.codexLoginTargets.delete(loginId);
                if (!target) throw new AccountError('internal', 'sign-in target lost');
                return this.storeChatgptAccount(target, info);
            },
            onEnd: (loginId, state) => {
                const target = this.codexLoginTargets.get(loginId);
                if (state === 'succeeded' || !target) return;
                this.codexLoginTargets.delete(loginId);
                // A NEW account's half-made overlay goes; a re-login keeps the account's.
                if (target.isNew) removeAccountSecret(this.home, target.accountId);
            },
        });
        return this.codexLogins;
    }

    /** loginId → the account a Codex sign-in writes. */
    private readonly codexLoginTargets = new Map<string, { accountId: string; label?: string; isNew: boolean }>();

    private async codexLoginStart(accountId: string | undefined, label: string | undefined): Promise<AgentProfileLoginStatus> {
        const accounts = readAccounts(this.home).accounts;
        let target: { accountId: string; label?: string; isNew: boolean };
        if (accountId) {
            const record = accounts[accountId];
            if (!record || record.kind !== 'codex-chatgpt') throw new AccountError('not-found', `no ChatGPT account "${accountId}"`);
            target = { accountId, isNew: false };
        } else {
            // Reserve the id now: the overlay must exist before Codex writes auth.json into it.
            const taken = [...Object.keys(accounts), ...[...this.codexLoginTargets.values()].map((t) => t.accountId)];
            target = { accountId: newAccountId(label ?? '', 'codex-chatgpt', taken), ...(label ? { label } : {}), isNew: true };
        }
        const manager = this.codexLoginManager();
        const busy = manager.activeLoginId();
        if (busy) throw new AccountError('login-busy', 'another Codex sign-in is in progress');
        const codexHome = accountCodexHomePath(this.home, target.accountId);
        syncCodexOverlay(codexHome, baseCodexHome(this.env), this.now());
        const status = await manager.start(codexHome);
        if (status.state === 'failed' || status.state === 'canceled' || status.state === 'expired') {
            if (target.isNew) removeAccountSecret(this.home, target.accountId);
            return status;
        }
        this.codexLoginTargets.set(status.loginId, target);
        return status;
    }

    /** A finished ChatGPT sign-in → the account record (new) or its refreshed status (re-login). */
    storeChatgptAccount(target: { accountId: string; label?: string; isNew: boolean }, info: { email?: string; planType?: string }): AgentProfileSummary {
        const file = readAccountsFileV2(this.home);
        const now = this.now();
        const existing = file.accounts[target.accountId];
        if (existing && existing.kind === 'codex-chatgpt') {
            existing.check = { status: 'ok', at: now };
            if (info.email) existing.email = info.email;
            if (info.planType) existing.planType = info.planType;
        } else {
            file.accounts[target.accountId] = {
                label: target.label?.trim() || info.email || 'ChatGPT',
                agent: 'codex',
                kind: 'codex-chatgpt',
                createdAt: now,
                check: { status: 'ok', at: now },
                ...(info.email ? { email: info.email } : {}),
                ...(info.planType ? { planType: info.planType } : {}),
            };
        }
        writeAccountsFile(this.home, file);
        this.changed();
        return this.summary(target.accountId);
    }

    private loginOp(fn: (m: SetupTokenLoginManager) => AgentProfileLoginStatus, loginId?: unknown, codex?: (m: CodexDeviceLoginManager) => AgentProfileLoginStatus): AgentProfileLoginStatus {
        try {
            if (codex && typeof loginId === 'string' && this.codexLogins?.has(loginId)) return codex(this.codexLogins);
            return fn(this.loginManager());
        } catch (error) {
            const code = (error as { code?: string }).code ?? 'internal';
            throw new AccountError(code, error instanceof Error ? error.message : String(error));
        }
    }

    loginSubmit(params: unknown): AgentProfileLoginStatus {
        const parsed = AgentProfileLoginSubmitRequestSchema.safeParse(params);
        if (!parsed.success) throw new AccountError('invalid-params', 'loginId and code are required');
        if (this.codexLogins?.has(parsed.data.loginId)) throw new AccountError('invalid-params', 'a Codex device-code sign-in has nothing to submit: enter the code on the sign-in page');
        return this.loginOp((m) => m.submit(parsed.data.loginId, parsed.data.code));
    }

    loginStatus(loginId: unknown): AgentProfileLoginStatus {
        if (typeof loginId !== 'string') throw new AccountError('invalid-params', 'loginId is required');
        return this.loginOp((m) => m.status(loginId), loginId, (m) => m.status(loginId));
    }

    loginCancel(loginId: unknown): AgentProfileLoginStatus {
        if (typeof loginId !== 'string') throw new AccountError('invalid-params', 'loginId is required');
        const status = this.loginOp((m) => m.cancel(loginId), loginId, (m) => m.cancel(loginId));
        this.loginTargets.delete(loginId);
        return status;
    }

    dispose(): void {
        this.logins?.dispose();
        this.codexLogins?.dispose();
    }

    // ---- sessions --------------------------------------------------------------

    /** Validates and writes a session binding (no restart). */
    writeBinding(sessionId: string, accountId: string | null, model?: string): void {
        if (accountId !== null) {
            const record = readAccounts(this.home).accounts[accountId];
            if (!record) throw new AccountError('not-found', `no account "${accountId}"`);
            const agent = this.deps.sessionAgent?.(sessionId);
            if (agent && agent !== record.agent) throw new AccountError('invalid-params', `"${accountId}" is a ${record.agent} account; this session runs ${agent}`);
            if (model !== undefined) {
                if (record.kind === 'claude-subscription') throw new AccountError('invalid-params', 'model applies to API and Codex accounts only');
                if (record.models && record.models.length > 0 && !record.models.includes(model)) {
                    throw new AccountError('invalid-params', `model "${model}" is not in ${accountId}'s models (${record.models.join(', ')})`);
                }
            }
        } else if (model !== undefined) {
            throw new AccountError('invalid-params', 'model cannot be set for the machine login');
        }
        writeSessionBinding(this.home, sessionId, { account: accountId, ...(model ? { model } : {}) });
    }

    async bind(params: unknown): Promise<AgentProfileBindResult> {
        const parsed = AgentProfileBindRequestSchema.safeParse(params);
        if (!parsed.success) throw new AccountError('invalid-params', parsed.error.issues[0]?.message ?? 'invalid params');
        const { sessionId, accountId, model, restart } = parsed.data;
        const previous = readSessionBindingV2(this.home, sessionId);
        this.writeBinding(sessionId, accountId, model);
        this.changed();
        if (restart === false || !this.deps.restartSession) return { bound: true, restart: 'skipped' };
        const outcome = await Promise.race([
            this.deps.restartSession(sessionId),
            new Promise<'pending'>((r) => setTimeout(() => r('pending'), BIND_RESTART_BUDGET_MS).unref?.()),
        ]);
        if (outcome === 'pending') return { bound: true, restart: 'pending' };
        if (outcome.ok) return { bound: true, restart: 'done' };
        // stillRunning first: a live wrapper on the old credential must never keep the new binding.
        if (outcome.stillRunning) {
            // Never "bound to the new account while running on the old one": undo.
            writeSessionBinding(this.home, sessionId, previous);
            this.changed();
            return { bound: false, rolledBack: true, restart: 'failed', error: outcome.error };
        }
        if (outcome.notRunning) return { bound: true, restart: 'skipped', error: outcome.error };
        return { bound: true, restart: 'failed', error: outcome.error };
    }

    /**
     * Spawn-time choice → the account a NEW session starts on.
     *   undefined → the machine default for this agent (none = machine login)
     *   null      → machine login
     *   id        → that account; must exist and be usable (Q3: never fall back)
     */
    resolveSpawnAccount(agent: string, requested: unknown): string | null {
        if (requested !== undefined && requested !== null && typeof requested !== 'string') {
            throw new AccountError('invalid-params', 'agentProfileId must be a string or null');
        }
        const file = readAccounts(this.home);
        const id = requested === undefined ? file.defaults[agent] ?? null : requested;
        if (id === null || id === '') return null;
        const record = file.accounts[id];
        if (!record) throw new AccountError('agent-profile-unavailable', `agent-profile-unavailable:missing: no account "${id}" on this machine`);
        if (record.agent !== agent) throw new AccountError('agent-profile-unavailable', `agent-profile-unavailable:agent-mismatch: "${id}" is a ${record.agent} account`);
        const { status } = summarizeAccount(this.home, id, record, defaultSecretProbe(this.env), this.now());
        if (status === 'missing-secret' || status === 'expired' || status === 'invalid') {
            throw new AccountError('agent-profile-unavailable', `agent-profile-unavailable:${status}: account "${record.label}"`);
        }
        return id;
    }
}
