import { z } from 'zod';

// B-850a: per-session accounts ("账号" in the UI; "agent profile" on the wire).
// Spec: specs/2026-11-session-accounts.md.
//
// An account belongs to ONE machine: its secret (setup-token, API key) never
// leaves that machine and is never in metadata, daemonState or an RPC result.
// The Web sees ids, labels, kinds and status only. A session's binding lives
// in a machine-local file; switching = write the binding + restart the session
// in place (history kept, only the credential changes).
//
// Every enum-ish field is a plain string (AGENTS #14): readers whitelist and
// treat an unknown value as the neutral case, so a newer CLI never makes an
// older Web drop the whole object.

/**
 * Session metadata capability: this wrapper honours an account binding (or
 * refuses to run on an unusable one — it never falls back to the machine
 * login) and reports `metadata.agentProfile`.
 */
export const AGENT_PROFILE_SESSION_CAPABILITY = 'agent-profile-v1';

/**
 * Machine capability = `daemonState.agentProfiles` is present and trusted
 * (`daemonPid === daemonState.pid`). Only then does the daemon serve the RPCs
 * below and the `agentProfileId` spawn param.
 */
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

/**
 * Kinds this CLI can create. Reserved for later PRs: pi-provider, gemini-api.
 *   codex-chatgpt  — B-850b: a ChatGPT sign-in (device code) in its own CODEX_HOME overlay
 *   codex-provider — B-850b: an API provider (a `[model_providers.X]` of the machine's
 *                    ~/.codex/config.toml, or an own URL) with a per-session key
 */
export const AGENT_PROFILE_KINDS = ['claude-subscription', 'claude-api', 'codex-chatgpt', 'codex-provider'] as const;
export type AgentProfileKind = (typeof AGENT_PROFILE_KINDS)[number];

/**
 * ok          — last check succeeded
 * unverified  — never checked (or check inconclusive: network)
 * expired     — subscription token past expiry or rejected (re-login)
 * invalid     — API key / URL rejected (fix the key)
 * missing-secret — key file / env var / stored token not found
 */
export const AGENT_PROFILE_STATUSES = ['ok', 'unverified', 'expired', 'invalid', 'missing-secret'] as const;
export type AgentProfileStatus = (typeof AGENT_PROFILE_STATUSES)[number];

export const AgentProfileSummarySchema = z.object({
    id: z.string(),
    label: z.string(),
    agent: z.string(),                      // 'claude' | 'codex' (pi/gemini later)
    kind: z.string(),                       // AgentProfileKind (open)
    status: z.string(),                     // AgentProfileStatus (open; unknown → 'unverified')
    statusDetail: z.string().optional(),    // short human reason for the last failed check
    checkedAt: z.number().optional(),
    createdAt: z.number().optional(),
    /** Subscription token expiry (ms). The UI derives 「即将过期」 from it. */
    expiresAt: z.number().optional(),
    /** API kinds: endpoint (not a secret). */
    baseUrl: z.string().optional(),
    /** API kinds: models the endpoint serves; first = default for a new binding. */
    models: z.array(z.string()).optional(),
    /** Where the key comes from: 'file' | 'env' | 'stored' (pasted / login-created, kept 0600 on the machine). */
    keySource: z.string().optional(),
    /** 'file' → the path, 'env' → the variable name. Never the key. */
    keyRef: z.string().optional(),
    /** Read from the B-794 `providers.json` (v1): listed and usable, but edit/remove it in that file. */
    legacy: z.boolean().optional(),
    /** B-850b codex-provider: the `[model_providers.<id>]` of ~/.codex/config.toml it is based on. */
    provider: z.string().optional(),
    /** B-850b codex-chatgpt: from Codex `account/read` after sign-in. */
    email: z.string().optional(),
    planType: z.string().optional(),
});
export type AgentProfileSummary = z.infer<typeof AgentProfileSummarySchema>;

/** `daemonState.agentProfiles` — also the result of `agent-profile-list`. */
export const AgentProfilesStateSchema = z.object({
    daemonPid: z.number(),
    updatedAt: z.number(),
    accounts: z.array(AgentProfileSummarySchema),
    /** agent → account id new sessions on this machine use when the spawn names none. Absent = machine login. */
    defaults: z.record(z.string(), z.string()),
    /**
     * B-850b: the account kinds this daemon can create (its AGENT_PROFILE_KINDS). Always sent from
     * B-850b on, so a codex-capable daemon with no config.toml providers is distinguishable from a
     * B-850a daemon. Absent (older daemon) = ['claude-subscription', 'claude-api'].
     */
    kinds: z.array(z.string()).optional(),
    /** B-850b: the providers in this machine's ~/.codex/config.toml (for the add form; no secrets). Absent when none. */
    codexProviders: z.array(z.object({
        id: z.string(),
        name: z.string().optional(),
        baseUrl: z.string().optional(),
        envKey: z.string().optional(),
    })).optional(),
    /**
     * B-850d: what else this daemon honours. `'launch-accounts'` = the account
     * chosen on a project / team / automation (and a fork's inherited one) is
     * used, and an unusable one refuses the run. Absent (B-850a/b daemon) =
     * those fields are ignored: such sessions start on the machine default
     * account, else the machine login — the Web says so next to the picker.
     */
    features: z.array(z.string()).optional(),
});
export type AgentProfilesState = z.infer<typeof AgentProfilesStateSchema>;

/**
 * `metadata.agentProfile`, written by the wrapper with what it ACTUALLY runs on:
 *   absent    — older wrapper (no capability): show nothing / 「本机登录」 guess
 *   null      — machine login (本机登录)
 *   { status: 'active' }      — running on this account
 *   { status: 'unavailable' } — bound, but the account cannot be used
 *       (reason: 'missing' | 'missing-secret' | 'expired' | 'invalid');
 *       the wrapper refuses turns until the user re-logs in or switches
 */
export const SessionAgentProfileSchema = z.object({
    id: z.string(),
    label: z.string(),
    kind: z.string(),
    status: z.string(),
    reason: z.string().optional(),
    /** API kinds: the model every slot is pinned to. */
    model: z.string().optional(),
});
export type SessionAgentProfile = z.infer<typeof SessionAgentProfileSchema>;

// ---- RPC params (daemon validates; every handler resolves `{ error, code }` on failure, AGENTS #17) ----

export const AgentProfileKeyInputSchema = z.discriminatedUnion('source', [
    z.object({ source: z.literal('file'), path: z.string().min(1).max(1024) }),
    z.object({ source: z.literal('env'), name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/) }),
    /** Q2: allowed, never the default. Relayed through the server (not stored there); kept 0600 on the machine. */
    z.object({ source: z.literal('paste'), value: z.string().min(1).max(4096) }),
]);
export type AgentProfileKeyInput = z.infer<typeof AgentProfileKeyInputSchema>;

export const AgentProfileModelInputSchema = z.union([
    z.string().min(1).max(160),
    z.object({ id: z.string().min(1).max(160), contextWindow: z.number().int().positive().optional() }),
]);

const BaseUrlSchema = z.string().regex(/^https?:\/\/\S+$/).max(512);

export const ClaudeApiAddRequestSchema = z.object({
    agent: z.literal('claude'),
    kind: z.literal('claude-api'),
    label: z.string().trim().min(1).max(60),
    baseUrl: BaseUrlSchema,
    models: z.array(AgentProfileModelInputSchema).max(50).optional(),
    key: AgentProfileKeyInputSchema,
});

/**
 * B-850b: a Codex API provider. `provider` = a `[model_providers.<id>]` of the
 * machine's ~/.codex/config.toml (its base_url / wire_api / headers are
 * inherited; `baseUrl` overrides); without one, `baseUrl` is required.
 */
export const CodexProviderAddRequestSchema = z.object({
    agent: z.literal('codex'),
    kind: z.literal('codex-provider'),
    label: z.string().trim().min(1).max(60),
    provider: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
    baseUrl: BaseUrlSchema.optional(),
    wireApi: z.enum(['responses', 'chat']).optional(),
    models: z.array(AgentProfileModelInputSchema).max(50).optional(),
    key: AgentProfileKeyInputSchema,
}).refine((r) => !!r.provider || !!r.baseUrl, { message: 'provider or baseUrl is required' });

export const AgentProfileAddRequestSchema = z.union([ClaudeApiAddRequestSchema, CodexProviderAddRequestSchema]);
export type AgentProfileAddRequest = z.infer<typeof AgentProfileAddRequestSchema>;

/**
 * Starts `claude setup-token` (paste-code flow) or, B-850b, a Codex ChatGPT
 * device-code sign-in on the machine. `accountId` = re-login an existing account.
 */
export const AgentProfileLoginStartRequestSchema = z.union([
    z.object({
        agent: z.literal('claude'),
        kind: z.literal('claude-subscription'),
        label: z.string().trim().min(1).max(60).optional(),
        accountId: z.string().optional(),
    }),
    z.object({
        agent: z.literal('codex'),
        kind: z.literal('codex-chatgpt'),
        /** Optional: a new account defaults to the signed-in email. */
        label: z.string().trim().min(1).max(60).optional(),
        accountId: z.string().optional(),
    }),
]);
export type AgentProfileLoginStartRequest = z.infer<typeof AgentProfileLoginStartRequestSchema>;

export const AgentProfileLoginSubmitRequestSchema = z.object({
    loginId: z.string(),
    code: z.string().trim().min(1).max(2048),
});

/**
 * paste-code (Claude):  waiting-code → (submit) → exchanging → succeeded | failed.
 * device-code (Codex):  waiting-code (the user enters `userCode` at `url`; nothing
 *                       to submit) → succeeded | failed.
 * canceled / expired (Claude 10 min without a code, Codex 15 min) are terminal too.
 */
export const AgentProfileLoginStatusSchema = z.object({
    loginId: z.string(),
    state: z.string(),
    /** B-850b: 'paste-code' | 'device-code' (absent = older CLI = paste-code). */
    flow: z.string().optional(),
    /** device-code: what the user types on the `url` page. Not a secret on its own (useless without the browser sign-in). */
    userCode: z.string().optional(),
    url: z.string().optional(),
    expiresAt: z.number().optional(),
    account: AgentProfileSummarySchema.optional(),
    error: z.string().optional(),
});
export type AgentProfileLoginStatus = z.infer<typeof AgentProfileLoginStatusSchema>;

export const AgentProfileBindRequestSchema = z.object({
    sessionId: z.string().min(1),
    /** null = back to the machine login. */
    accountId: z.string().nullable(),
    /** API kinds only; default = the account's first model. */
    model: z.string().max(160).optional(),
    /** Default true: restart the session in place now. */
    restart: z.boolean().optional(),
});
export type AgentProfileBindRequest = z.infer<typeof AgentProfileBindRequestSchema>;

export type AgentProfileBindResult = {
    /**
     * false only with `rolledBack` — the restart failed while the session's
     * wrapper kept running on the previous credential, so the previous binding
     * was restored (never "bound to the new account, running the old one").
     */
    bound: boolean;
    /** The new binding was undone (see `bound`); the session runs on its previous account. */
    rolledBack?: true;
    /**
     * 'done'    — restarted in place on the new account
     * 'skipped' — restart:false, or the session is not running here (applies on next start)
     * 'pending' — still restarting after the 22 s budget (relay RPCs cap at 30 s); the Web
     *             shows 「重启中」 and treats `metadata.agentProfile` turning into the new
     *             account as done
     * 'failed'  — the session is not running any more: binding kept, applies on next
     *             start; or (`rolledBack`) it still runs: the previous binding is restored
     */
    restart: string;
    error?: string;
};

/**
 * `agent-profile-remove` result. With `force` and bound sessions, each of them is
 * restarted in place right away and comes back `unavailable` (no fallback);
 * `restarts` = sessionId → 'done' | 'skipped' | 'pending' | 'failed' (as in bind).
 */
export type AgentProfileRemoveResult = { removed: true; sessions: string[]; restarts?: Record<string, string> };

export type AgentProfileRpcError = { error: string; code: string; sessions?: string[] };

const STATUS_SET: ReadonlySet<string> = new Set(AGENT_PROFILE_STATUSES);
/** Whitelisted read of a status string (unknown → 'unverified'). */
export function readAgentProfileStatus(value: unknown): AgentProfileStatus {
    return typeof value === 'string' && STATUS_SET.has(value) ? (value as AgentProfileStatus) : 'unverified';
}

/** Whitelisted read of `metadata.agentProfile`: undefined = old wrapper, null = machine login. */
export function readSessionAgentProfile(value: unknown): SessionAgentProfile | null | undefined {
    if (value === null) return null;
    const parsed = SessionAgentProfileSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
}

// ---- B-850d: accounts chosen on a project / team / automation ----

export const AGENT_PROFILE_FEATURE_LAUNCH = 'launch-accounts';

/**
 * An account picked for a project / team / automation, as stored on the
 * server: the machine-local id plus a display label (for 「『组织 A』在
 * mac-office 上不存在」). Never a secret. Where it is a choice the three
 * states are: absent = not chosen (next level decides), `null` = the machine
 * login explicitly, a ref = that account.
 */
export const AgentProfileRefSchema = z.object({
    id: z.string().min(1).max(64),
    label: z.string().min(1).max(200).optional(),
});
export type AgentProfileRef = z.infer<typeof AgentProfileRefSchema>;
export const AgentProfileChoiceSchema = AgentProfileRefSchema.nullable();

/**
 * `ProjectDefaults.agentProfiles[]`: the account new sessions of this project
 * use for `agent` on `machineId` (accounts are per machine, so on any other
 * machine the project has no account default). `id: null` = machine login.
 */
export const ProjectAgentProfileSchema = z.object({
    agent: z.string().min(1).max(64),
    machineId: z.string().min(1).max(128),
    id: z.string().min(1).max(64).nullable(),
    label: z.string().min(1).max(200).optional(),
});
export type ProjectAgentProfile = z.infer<typeof ProjectAgentProfileSchema>;
export const ProjectAgentProfilesSchema = z.array(ProjectAgentProfileSchema).max(16);

export type LaunchAgentProfile = {
    /** The spawn's `agentProfileId`: id, `null` (machine login) or undefined (the daemon's machine default, else machine login). */
    agentProfileId: string | null | undefined;
    source: 'explicit' | 'project' | 'machine';
};

/**
 * Which account a new session starts on — explicit (the session / team /
 * automation's own choice) > project default for this agent on this machine
 * > machine default (the daemon) > machine login. Pure; the daemon, the CLI
 * and the Web share it.
 */
export function resolveLaunchAgentProfile(input: {
    explicit?: AgentProfileRef | null;
    project?: readonly ProjectAgentProfile[] | null;
    agent: string;
    machineId: string;
}): LaunchAgentProfile {
    if (input.explicit !== undefined) return { agentProfileId: input.explicit === null ? null : input.explicit.id, source: 'explicit' };
    const entry = input.project?.find((p) => p.agent === input.agent && p.machineId === input.machineId);
    if (entry) return { agentProfileId: entry.id, source: 'project' };
    return { agentProfileId: undefined, source: 'machine' };
}

/** Project default entries that apply on one machine (what a daemon needs of a project). */
export function projectAgentProfilesFor(entries: readonly ProjectAgentProfile[] | null | undefined, machineId: string): ProjectAgentProfile[] {
    return (entries ?? []).filter((e) => e.machineId === machineId);
}

/** `agent-profile-unavailable:<reason>: …` (daemon spawn error) → reason, else null. */
export function agentProfileUnavailableReason(error: string | null | undefined): string | null {
    const m = /^agent-profile-unavailable:([a-z-]+)/.exec(error ?? '');
    return m ? m[1] : null;
}
