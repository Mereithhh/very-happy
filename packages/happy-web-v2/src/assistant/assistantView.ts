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
    /** newest tool call (name + state + raw input) for the ticker, null when none */
    tool: { name: string; state: 'running' | 'completed' | 'error'; input: unknown } | null;
    /** which of user/assistant is newest — options are only offered while the
     *  assistant's question is still the latest word in the conversation */
    latestRole: 'user' | 'assistant' | null;
}

export function deriveAssistantExchange(messages: Message[]): AssistantExchange {
    const sorted = [...messages].sort(compareMessagesNewestFirst); // newest first
    let userText: string | null = null;
    let assistantText: string | null = null;
    let tool: AssistantExchange['tool'] = null;
    let latestRole: AssistantExchange['latestRole'] = null;
    for (const m of sorted) {
        if (m.inputState !== undefined) continue;
        if (userText === null && m.kind === 'user-text') {
            userText = m.displayText ?? m.text;
            latestRole = latestRole ?? 'user';
        } else if (assistantText === null && m.kind === 'agent-text' && !m.isThinking && m.text.trim()) {
            assistantText = m.text;
            latestRole = latestRole ?? 'assistant';
        } else if (tool === null && m.kind === 'tool-call') {
            tool = { name: m.tool.name, state: m.tool.state, input: m.tool.input };
        }
        if (userText !== null && assistantText !== null && tool !== null) break;
    }
    return { userText, assistantText, tool, latestRole };
}

/**
 * B-059 follow-up: assistant replies may carry a machine-readable options
 * block (the CLAUDE.md template asks for it when posing a multiple choice):
 *
 *   <options>
 *   <option>先派 B-051 收尾发布</option>
 *   <option>先做稳定性三件套</option>
 *   </options>
 *
 * The UI renders these as tappable answer buttons; the block must never reach
 * the visible text or the TTS queue (spoken XML is noise).
 */
export interface ExtractedOptions {
    text: string;
    options: string[];
}

export function extractOptions(raw: string): ExtractedOptions {
    const options: string[] = [];
    const text = raw
        .replace(/<options>([\s\S]*?)<\/options>/g, (_all, inner: string) => {
            for (const m of inner.matchAll(/<option>([\s\S]*?)<\/option>/g)) {
                const t = m[1].trim();
                if (t) options.push(t);
            }
            return '';
        })
        .trim();
    return { text, options };
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

// ── B-059: in-place text transcript ─────────────────────────────────────────

export interface TranscriptEntry {
    id: string;
    role: 'user' | 'assistant' | 'tool' | 'thinking';
    text: string;
    /** collapsible payload: thinking trace body, or a tool's input preview */
    detail?: string;
    /** tool rows only (B-092): raw name + state, so the screen can render a
     *  friendly label + icon while `text` stays the raw fallback */
    toolName?: string;
    toolState?: 'running' | 'completed' | 'error';
}

const TOOL_DETAIL_MAX_CHARS = 600;

/**
 * Full conversation as flat entries, oldest-first, for the assistant screen's
 * transcript panel. Thinking traces become collapsible 'thinking' entries;
 * tool calls carry a truncated input preview as collapsible detail; an
 * assistant reply's <options> block is flattened to visible "▸ …" lines.
 */
export function deriveTranscript(messages: Message[]): TranscriptEntry[] {
    const sorted = [...messages].sort(compareMessagesNewestFirst).reverse(); // oldest first
    const out: TranscriptEntry[] = [];
    for (const m of sorted) {
        if (m.inputState !== undefined) continue;
        if (m.kind === 'user-text') {
            const text = (m.displayText ?? m.text).trim();
            if (text) out.push({ id: m.id, role: 'user', text });
        } else if (m.kind === 'agent-text') {
            if (!m.text.trim()) continue;
            if (m.isThinking) {
                out.push({ id: m.id, role: 'thinking', text: '', detail: m.text.trim() });
            } else {
                const { text, options } = extractOptions(m.text);
                const withOptions =
                    options.length > 0
                        ? [text, ...options.map((o) => `▸ ${o}`)].filter(Boolean).join('\n')
                        : text;
                if (withOptions) out.push({ id: m.id, role: 'assistant', text: withOptions });
            }
        } else if (m.kind === 'tool-call') {
            let detail: string | undefined;
            try {
                const s = JSON.stringify(m.tool.input);
                if (s && s !== '{}') {
                    detail = s.length > TOOL_DETAIL_MAX_CHARS ? `${s.slice(0, TOOL_DETAIL_MAX_CHARS)}…` : s;
                }
            } catch {
                // non-serializable input — skip the preview
            }
            out.push({
                id: m.id,
                role: 'tool',
                text: `${m.tool.name} · ${m.tool.state}`,
                detail,
                toolName: m.tool.name,
                toolState: m.tool.state,
            });
        }
    }
    return out;
}
