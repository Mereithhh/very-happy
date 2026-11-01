/**
 * B-850c2 (wire v3): after a Codex account switch the new account may refuse
 * the thread's history; the wrapper then writes an
 * `agent-profile-history-rejected` event. The banner stays while that is the
 * latest word: the account it names is still the session's and no agent reply
 * came after it. Pure: no React, no stores.
 */
import type { Message } from '@/sync/typesMessage';
import type { SessionAgentProfile } from '@/sync/agentProfiles';

export const HISTORY_REJECTED_EVENT_KIND = 'agent-profile-history-rejected';

/** The CLI line names the account: `… on account "<label>". …` */
export function historyRejectedLabel(message: string): string | null {
    const match = /on account "([^"]*)"/.exec(message);
    return match ? match[1] : null;
}

export function historyRejectedFor(messages: readonly Message[], profile: SessionAgentProfile | null | undefined): { at: number; label: string | null } | null {
    let rejected: { at: number; label: string | null } | null = null;
    let replyAt = -Infinity;
    for (const message of messages) {
        if (message.kind === 'agent-text') replyAt = Math.max(replyAt, message.createdAt);
        if (message.kind !== 'agent-event' || message.event.type !== 'message' || message.event.kind !== HISTORY_REJECTED_EVENT_KIND) continue;
        if (!rejected || message.createdAt > rejected.at) rejected = { at: message.createdAt, label: historyRejectedLabel(message.event.message) };
    }
    if (!rejected || replyAt > rejected.at) return null;
    // Switched since (back, or to another account): the refusal is history.
    if (!profile || profile.status !== 'active') return null;
    if (rejected.label !== null && rejected.label !== profile.label) return null;
    return rejected;
}

/**
 * 【新开会话】 starts on the account that refused the history (CLI: "Start a new
 * session on it"): the one the event names, else what the session runs on now.
 * null = the machine login.
 */
export function newSessionAccountFor(
    rejectedLabel: string | null,
    accounts: readonly { id: string; label: string; agent: string }[],
    agent: string,
    current: SessionAgentProfile | null | undefined,
): string | null {
    const named = rejectedLabel !== null ? accounts.find((a) => a.agent === agent && a.label === rejectedLabel) : undefined;
    if (named) return named.id;
    return current ? current.id : null;
}
