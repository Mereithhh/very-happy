/**
 * B-850c machine RPC wrappers for `agent-profile-*` (B-850a wire v1). Iron
 * rule 17: a resolved RPC may still be `{ error, code }` (an old daemon answers
 * `Method not found`), so every call checks `error` first. A pasted API key is
 * in `agent-profile-add` params only — relayed inside the machine-key-encrypted
 * RPC, never stored by the server (Q2) — and nothing here logs params.
 */
import { apiSocket } from './apiSocket';
import { isUnsupportedRpcError } from '@/utils/worktree';
import {
    AGENT_PROFILE_RPC,
    AgentProfileSummarySchema,
    parseAgentProfilesState,
    parseLoginStatus,
    type AgentProfileSummary,
    type AgentProfilesState,
    type LoginStatus,
} from './agentProfiles';

export type AgentProfileRpcResult<T> =
    | { ok: true; data: T }
    | { ok: false; error: string; code?: string; sessions?: string[]; unsupported: boolean };

type Raw = Record<string, unknown>;

/** Test (≤25 s) + relay margin, still under the server's 30 s RPC cap (AGENTS #17). */
const TIMEOUT_MS = 29_000;

/** `ack`: a reply that carries `error` yet succeeded (bind: `{ bound: true, restart: 'failed', error }`). */
async function call<T>(machineId: string, method: string, params: Raw, read: (obj: Raw) => T | null, ack?: (obj: Raw) => boolean): Promise<AgentProfileRpcResult<T>> {
    try {
        const raw = await apiSocket.machineRPC<unknown, Raw>(machineId, method, params, { timeoutMs: TIMEOUT_MS });
        const obj = raw && typeof raw === 'object' ? raw as Raw : null;
        if (!obj) return { ok: false, error: 'Empty response', unsupported: false };
        if (typeof obj.error === 'string' && obj.error && !ack?.(obj)) {
            return {
                ok: false,
                error: obj.error,
                ...(typeof obj.code === 'string' ? { code: obj.code } : {}),
                ...(Array.isArray(obj.sessions) ? { sessions: obj.sessions.filter((s): s is string => typeof s === 'string') } : {}),
                unsupported: isUnsupportedRpcError(obj.error),
            };
        }
        const data = read(obj);
        return data === null ? { ok: false, error: 'Unexpected response', unsupported: false } : { ok: true, data };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message, unsupported: isUnsupportedRpcError(message) };
    }
}

const readAccount = (obj: Raw): AgentProfileSummary | null => {
    const parsed = AgentProfileSummarySchema.safeParse(obj.account);
    return parsed.success ? parsed.data : null;
};

/** An `{ account }` reply is an answer even with `error` beside it: a failed test is an account with a bad status, not an RPC failure. */
const isAccountReply = (obj: Raw): boolean => AgentProfileSummarySchema.safeParse(obj.account).success;

export type AgentProfileKeyInput =
    | { source: 'file'; path: string }
    | { source: 'env'; name: string }
    | { source: 'paste'; value: string };

export const agentProfileList = (machineId: string) =>
    call<AgentProfilesState>(machineId, AGENT_PROFILE_RPC.list, {}, parseAgentProfilesState);

/** Wire v1 claude-api, or wire v3 codex-provider (`provider` and/or `baseUrl`; a provider's settings are inherited). */
export type AgentProfileAddInput =
    | { agent: 'claude'; kind: 'claude-api'; label: string; baseUrl: string; models: string[]; key: AgentProfileKeyInput }
    | { agent: 'codex'; kind: 'codex-provider'; label: string; provider?: string; baseUrl?: string; wireApi?: 'responses' | 'chat'; models: string[]; key: AgentProfileKeyInput };

export const agentProfileAdd = (machineId: string, input: AgentProfileAddInput) =>
    call<AgentProfileSummary>(machineId, AGENT_PROFILE_RPC.add, input, readAccount, isAccountReply);

/**
 * A LoginStatus is an answer even when it carries `error`: a failed sign-in is
 * `{ loginId, state: 'failed', error: 'OAuth error: Invalid code…' }`, which must
 * reach the dialog as that state and reason — not as an RPC failure the poller
 * ignores (it then spun on 「验证中…」 until the 10-minute expiry).
 */
export const isLoginStatusReply = (obj: Raw): boolean => typeof obj.loginId === 'string' && typeof obj.state === 'string';

/** Claude: setup-token (paste-code). Codex (wire v3): ChatGPT device code; a new account's label defaults to the email. */
export type AgentProfileLoginKind = { agent: 'claude'; kind: 'claude-subscription' } | { agent: 'codex'; kind: 'codex-chatgpt' };

export const agentProfileLoginStart = (machineId: string, input: AgentProfileLoginKind & { label?: string; accountId?: string }) =>
    call<LoginStatus>(machineId, AGENT_PROFILE_RPC.loginStart, input, parseLoginStatus, isLoginStatusReply);

export const agentProfileLoginSubmit = (machineId: string, loginId: string, code: string) =>
    call<LoginStatus>(machineId, AGENT_PROFILE_RPC.loginSubmit, { loginId, code }, parseLoginStatus, isLoginStatusReply);

export const agentProfileLoginStatus = (machineId: string, loginId: string) =>
    call<LoginStatus>(machineId, AGENT_PROFILE_RPC.loginStatus, { loginId }, parseLoginStatus, isLoginStatusReply);

export const agentProfileLoginCancel = (machineId: string, loginId: string) =>
    call<LoginStatus>(machineId, AGENT_PROFILE_RPC.loginCancel, { loginId }, parseLoginStatus, isLoginStatusReply);

export const agentProfileTest = (machineId: string, accountId: string) =>
    call<AgentProfileSummary>(machineId, AGENT_PROFILE_RPC.test, { accountId }, readAccount, isAccountReply);

export const agentProfileRename = (machineId: string, accountId: string, label: string) =>
    call<AgentProfileSummary>(machineId, AGENT_PROFILE_RPC.rename, { accountId, label }, readAccount);

export const agentProfileRemove = (machineId: string, accountId: string, force = false) =>
    call<true>(machineId, AGENT_PROFILE_RPC.remove, { accountId, ...(force ? { force: true } : {}) }, (obj) => (obj.removed === true ? true : null));

export const agentProfileSetDefault = (machineId: string, agent: string, accountId: string | null) =>
    call<AgentProfilesState>(machineId, AGENT_PROFILE_RPC.setDefault, { agent, accountId }, parseAgentProfilesState);

/** 'pending': the daemon restarts once the running turn ends (B-850a, beyond wire v1). */
export type BindResult = { restart: 'done' | 'pending' | 'skipped' | 'failed'; error?: string };

export const agentProfileBind = (machineId: string, input: { sessionId: string; accountId: string | null; model?: string; restart?: boolean }) =>
    call<BindResult>(machineId, AGENT_PROFILE_RPC.bind, input, (obj) => {
        if (obj.bound !== true) return null;
        const restart = obj.restart === 'done' || obj.restart === 'pending' || obj.restart === 'skipped' ? obj.restart : 'failed';
        return { restart, ...(typeof obj.error === 'string' ? { error: obj.error } : {}) };
    }, (obj) => obj.bound === true);
