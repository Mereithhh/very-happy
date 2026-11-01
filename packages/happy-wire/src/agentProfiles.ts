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

/** Kinds this CLI can create. Reserved for later PRs: codex-chatgpt, codex-provider, pi-provider, gemini-api. */
export const AGENT_PROFILE_KINDS = ['claude-subscription', 'claude-api'] as const;
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
    agent: z.string(),                      // 'claude' (codex/pi/gemini later)
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
});
export type AgentProfileSummary = z.infer<typeof AgentProfileSummarySchema>;

/** `daemonState.agentProfiles` — also the result of `agent-profile-list`. */
export const AgentProfilesStateSchema = z.object({
    daemonPid: z.number(),
    updatedAt: z.number(),
    accounts: z.array(AgentProfileSummarySchema),
    /** agent → account id new sessions on this machine use when the spawn names none. Absent = machine login. */
    defaults: z.record(z.string(), z.string()),
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

export const AgentProfileAddRequestSchema = z.object({
    agent: z.literal('claude'),
    kind: z.literal('claude-api'),
    label: z.string().trim().min(1).max(60),
    baseUrl: z.string().regex(/^https?:\/\/\S+$/).max(512),
    models: z.array(AgentProfileModelInputSchema).max(50).optional(),
    key: AgentProfileKeyInputSchema,
});
export type AgentProfileAddRequest = z.infer<typeof AgentProfileAddRequestSchema>;

/** Starts `claude setup-token` on the machine. `accountId` = re-login an existing subscription account. */
export const AgentProfileLoginStartRequestSchema = z.object({
    agent: z.literal('claude'),
    kind: z.literal('claude-subscription'),
    label: z.string().trim().min(1).max(60).optional(),
    accountId: z.string().optional(),
});
export type AgentProfileLoginStartRequest = z.infer<typeof AgentProfileLoginStartRequestSchema>;

export const AgentProfileLoginSubmitRequestSchema = z.object({
    loginId: z.string(),
    code: z.string().trim().min(1).max(2048),
});

/**
 * waiting-code → (submit) → exchanging → succeeded | failed.
 * canceled / expired (10 min without a code) are terminal too.
 */
export const AgentProfileLoginStatusSchema = z.object({
    loginId: z.string(),
    state: z.string(),
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
    bound: true;
    /**
     * 'done'    — restarted in place on the new account
     * 'skipped' — restart:false, or the session is not running here (applies on next start)
     * 'pending' — still restarting after the 22 s budget (relay RPCs cap at 30 s); the Web
     *             shows 「重启中」 and treats `metadata.agentProfile` turning into the new
     *             account as done
     * 'failed'  — binding kept; applies on next start
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
