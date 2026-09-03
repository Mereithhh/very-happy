import { isClaudeAuthStale, readClaudeAuth } from '@/sync/claudeAuth';
import type { Machine } from '@/sync/storageTypes';
import type { SessionAgent } from '@/utils/agentAvailability';

/**
 * B-301 — surface a machine's Claude login in the launcher, not only after the
 * first turn fails.
 *
 * `daemonState.claudeAuth` (B-276) has always been rendered on the machine page
 * alone, so the new-session picker would happily start a Claude session on a
 * machine whose login is dead; the user found out when the turn came back with
 * `authentication_failed`. That is the report that produced B-297.
 *
 * The hard rule here is **never warn from absence of information**: an old CLI
 * publishes no state at all, a stale probe is not evidence, and `unknown` is
 * what a Bedrock/API-key machine reports by design (spec D1 — the probe
 * deliberately refuses to call those not-logged-in). Each of those stays silent.
 */
export type ClaudeAuthNotice =
    | { kind: 'none' }
    | { kind: 'not-logged-in'; diagnosis?: string }
    | { kind: 'unhealthy'; status: string };

export function claudeAuthNotice(
    machine: Pick<Machine, 'daemonState'> | null | undefined,
    agent: SessionAgent,
    now = Date.now(),
): ClaudeAuthNotice {
    // Only the Claude launcher reads the Claude login. Terminals are tmux, and
    // the other agents carry their own credentials.
    if (agent !== 'claude') return { kind: 'none' };
    const state = readClaudeAuth(machine);
    if (!state) return { kind: 'none' };
    if (isClaudeAuthStale(state, now)) return { kind: 'none' };
    switch (state.status) {
        case 'not-logged-in':
            return { kind: 'not-logged-in', diagnosis: state.diagnosis };
        case 'error':
        case 'claude-missing':
            return { kind: 'unhealthy', status: state.status };
        default:
            return { kind: 'none' };
    }
}

export function hasClaudeAuthNotice(notice: ClaudeAuthNotice): boolean {
    return notice.kind !== 'none';
}
