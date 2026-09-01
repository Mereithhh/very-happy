import { AgentEvent } from "./typesRaw";
import { MessageMeta } from "./typesMessageMeta";

export type ToolCall = {
    name: string;
    state: 'running' | 'completed' | 'error';
    input: any;
    createdAt: number;
    startedAt: number | null;
    completedAt: number | null;
    description: string | null;
    result?: any;
    permission?: {
        id: string;
        status: 'pending' | 'approved' | 'denied' | 'canceled';
        reason?: string;
        mode?: string;
        allowedTools?: string[];
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
        date?: number;
    };
}

/**
 * Ordering keys shared by all message kinds. The chat list sorts by `seq`
 * (server-assigned conversation order) first, then `createdAt`, then
 * `sortOrder` (reducer creation counter). `createdAt` alone is not a total
 * order: the server stamps a whole POSTed batch with a single transaction
 * timestamp, so batched messages tie on it.
 */
export type MessageOrdering = {
    /** Server-assigned per-session sequence number; null/undefined for locally synthesized messages. */
    seq?: number | null;
    /** Monotonic reducer creation counter; last-resort ordering tiebreaker. */
    sortOrder?: number;
    /** Visual consumption boundary for queued input; source seq remains immutable. */
    displaySeq?: number | null;
    /** Timestamp fallback for an optimistic queued input without a server seq. */
    displayAt?: number;
    /** Persisted input/file item waiting for the preceding turn to finish. */
    inputState?: 'queued' | 'canceled';
}

// Flattened message types - each message represents a single block
export type UserTextMessage = MessageOrdering & {
    kind: 'user-text';
    id: string;
    localId: string | null;
    createdAt: number;
    text: string;
    displayText?: string; // Optional text to display in UI instead of actual text
    meta?: MessageMeta;
    /**
     * Claude conversation-file `uuid` corresponding to this message. Used as
     * the rewind point when forking / duplicating a session. Optional —
     * older messages and non-Claude agents may not have one.
     */
    claudeUuid?: string;
    /**
     * Codex app-server item id corresponding to this user message. Used as
     * the rewind point when duplicating/forking Codex threads.
     */
    codexItemId?: string;
}

export type ModeSwitchMessage = MessageOrdering & {
    kind: 'agent-event';
    id: string;
    createdAt: number;
    event: AgentEvent;
    meta?: MessageMeta;
}

/**
 * Per-turn token usage carried on an agent text message. Mirrors
 * `MessageMetaUsage` (camelCase) so it can be passed straight to MessageMetaRow.
 */
export type MessageUsage = {
    inputTokens: number;
    outputTokens: number;
    cacheCreation?: number;
    cacheRead?: number;
}

export type AgentTextMessage = MessageOrdering & {
    kind: 'agent-text';
    id: string;
    localId: string | null;
    createdAt: number;
    text: string;
    isThinking?: boolean;
    meta?: MessageMeta;
    /**
     * Per-turn metadata, populated on the final agent-text message of a
     * completed turn from the Claude Code SDK result message:
     * - `usage`: per-message token usage from the assistant message itself.
     * - `costUsd` / `totalDurationMs` / `numTurns`: from the turn's result.
     */
    usage?: MessageUsage;
    costUsd?: number;
    totalDurationMs?: number;
    numTurns?: number;
}

/** B-260-P2: lifecycle of the sub-agent an Agent/Task call launched (from CLI task_* events). */
export type SubagentLifecycle = {
    status: 'running' | 'completed' | 'failed' | 'stopped';
    title?: string;
    description?: string;
    subagentType?: string;
    progress?: { toolUses: number; lastTool?: string; totalTokens?: number; durationMs?: number; summary?: string };
    result?: { text: string; truncated?: boolean };
    usage?: { toolUses?: number; totalTokens?: number; durationMs?: number };
    /** createdAt of the latest lifecycle event folded in. */
    updatedAt: number;
};

export type ToolCallMessage = MessageOrdering & {
    kind: 'tool-call';
    id: string;
    localId: string | null;
    createdAt: number;
    tool: ToolCall;
    children: Message[];
    meta?: MessageMeta;
    /** Present only when the CLI published lifecycle events for this call's sub-agent. */
    subagent?: SubagentLifecycle;
}

export type Message = UserTextMessage | AgentTextMessage | ToolCallMessage | ModeSwitchMessage;
