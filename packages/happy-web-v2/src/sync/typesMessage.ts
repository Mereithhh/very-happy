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

// Flattened message types - each message represents a single block
export type UserTextMessage = {
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

export type ModeSwitchMessage = {
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

export type AgentTextMessage = {
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

export type ToolCallMessage = {
    kind: 'tool-call';
    id: string;
    localId: string | null;
    createdAt: number;
    tool: ToolCall;
    children: Message[];
    meta?: MessageMeta;
}

export type Message = UserTextMessage | AgentTextMessage | ToolCallMessage | ModeSwitchMessage;
