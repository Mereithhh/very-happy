/**
 * Assistant view derivation (pure, unit-tested): map a session's message list
 * to what the voice screen shows — the latest exchange, the tool ticker, and
 * which agent replies are NEW (candidates for TTS).
 *
 * Message ordering rules are non-trivial (seq / createdAt / sortOrder, see
 * messageOrder.ts) — everything here sorts through the shared comparator
 * instead of assuming the store's array order.
 */

import type { Message, AgentTextMessage } from '@/sync/typesMessage';
import type { AgentState } from '@/sync/storageTypes';
import { compareMessagesNewestFirst } from '@/sync/messageOrder';

export interface AssistantExchange {
    /** newest user message text (displayText preferred), null when none */
    userText: string | null;
    /** newest non-thinking agent reply text, null when none */
    assistantText: string | null;
    /** newest tool call (name + state) for the mono ticker, null when none */
    tool: { name: string; state: 'running' | 'completed' | 'error' } | null;
}

export function deriveAssistantExchange(messages: Message[]): AssistantExchange {
    const sorted = [...messages].sort(compareMessagesNewestFirst); // newest first
    let userText: string | null = null;
    let assistantText: string | null = null;
    let tool: AssistantExchange['tool'] = null;
    for (const m of sorted) {
        if (userText === null && m.kind === 'user-text') {
            userText = m.displayText ?? m.text;
        } else if (assistantText === null && m.kind === 'agent-text' && !m.isThinking && m.text.trim()) {
            assistantText = m.text;
        } else if (tool === null && m.kind === 'tool-call') {
            tool = { name: m.tool.name, state: m.tool.state };
        }
        if (userText !== null && assistantText !== null && tool !== null) break;
    }
    return { userText, assistantText, tool };
}

/**
 * Agent replies that arrived AFTER the baseline (the ids present when the
 * screen mounted / the conversation was reset). Oldest-first so they are read
 * in conversation order. Thinking blocks and empty texts are never read.
 */
export function collectNewAgentTexts(
    messages: Message[],
    knownIds: ReadonlySet<string>,
): AgentTextMessage[] {
    return messages
        .filter(
            (m): m is AgentTextMessage =>
                m.kind === 'agent-text' && !m.isThinking && !!m.text.trim() && !knownIds.has(m.id),
        )
        .sort((a, b) => compareMessagesNewestFirst(b, a)); // oldest first
}

/** Snapshot every message id — the TTS baseline captured on mount/reset. */
export function collectMessageIds(messages: Message[]): Set<string> {
    return new Set(messages.map((m) => m.id));
}

export interface PendingPermission {
    /** request id of the newest pending permission request */
    id: string;
    /** tool name of that request (what the banner shows) */
    tool: string;
    /** total number of pending requests */
    count: number;
}

/**
 * Latest undecided permission request on a session, from
 * `Session.agentState.requests` — the same source the session page's
 * PermissionCard renders (requests are removed from the record once decided,
 * so presence == pending). Newest by `createdAt`; entries without a timestamp
 * sort oldest. Null when nothing is pending.
 */
export function derivePendingPermission(agentState: AgentState | null | undefined): PendingPermission | null {
    const requests = agentState?.requests;
    if (!requests) return null;
    let latest: { id: string; tool: string; createdAt: number } | null = null;
    let count = 0;
    for (const [id, r] of Object.entries(requests)) {
        if (!r || typeof r.tool !== 'string') continue;
        count += 1;
        const createdAt = typeof r.createdAt === 'number' ? r.createdAt : 0;
        if (!latest || createdAt > latest.createdAt) {
            latest = { id, tool: r.tool, createdAt };
        }
    }
    return latest ? { id: latest.id, tool: latest.tool, count } : null;
}
