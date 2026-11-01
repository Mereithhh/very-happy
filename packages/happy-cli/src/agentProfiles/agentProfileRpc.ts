/**
 * B-850a machine RPCs `agent-profile-*` (spec specs/2026-11-session-accounts.md).
 * Gated on `daemonState.agentProfiles`: an old daemon answers `Method not
 * found`, which the Web turns into "upgrade the CLI".
 *
 * Params arrive machine-key encrypted and are never logged (RpcHandlerManager
 * logs method names only); a pasted key is in `agent-profile-add` params and
 * nowhere else. Failures resolve `{ error, code }` (AGENTS #17).
 */
import { AGENT_PROFILE_RPC } from '@slopus/happy-wire';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { AccountError, type AccountService } from './accountService';

type Params = Record<string, unknown>;
const obj = (value: unknown): Params => (value && typeof value === 'object' ? value as Params : {});

export async function guarded<T>(fn: () => T | Promise<T>): Promise<T | { error: string; code: string; sessions?: string[] }> {
    try {
        return await fn();
    } catch (error) {
        if (error instanceof AccountError) return { error: error.message, code: error.code, ...(error.sessions ? { sessions: error.sessions } : {}) };
        return { error: error instanceof Error ? error.message : 'Unknown error', code: 'internal' };
    }
}

export function registerAgentProfileHandlers(rpc: Pick<RpcHandlerManager, 'registerHandler'>, service: AccountService): void {
    const on = (method: string, fn: (p: Params) => unknown) => rpc.registerHandler(method, (params: unknown) => guarded(() => fn(obj(params))));
    on(AGENT_PROFILE_RPC.list, () => service.state());
    on(AGENT_PROFILE_RPC.add, async (p) => ({ account: await service.add(p) }));
    on(AGENT_PROFILE_RPC.loginStart, (p) => service.loginStart(p));
    on(AGENT_PROFILE_RPC.loginSubmit, (p) => service.loginSubmit(p));
    on(AGENT_PROFILE_RPC.loginStatus, (p) => service.loginStatus(p.loginId));
    on(AGENT_PROFILE_RPC.loginCancel, (p) => service.loginCancel(p.loginId));
    on(AGENT_PROFILE_RPC.test, async (p) => ({ account: await service.test(p.accountId) }));
    on(AGENT_PROFILE_RPC.rename, (p) => ({ account: service.rename(p.accountId, p.label) }));
    on(AGENT_PROFILE_RPC.remove, (p) => service.remove(p.accountId, p.force));
    on(AGENT_PROFILE_RPC.setDefault, (p) => service.setDefault(p.agent, p.accountId === undefined ? null : p.accountId));
    on(AGENT_PROFILE_RPC.bind, (p) => service.bind(p));
}
