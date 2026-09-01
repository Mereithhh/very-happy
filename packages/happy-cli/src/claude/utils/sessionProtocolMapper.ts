import { createId } from '@paralleldrive/cuid2';
import type { RawJSONLines } from '@/claude/types';
import {
    createEnvelope,
    type SessionEnvelope,
    type SessionTurnEndStatus,
} from '@slopus/happy-wire';
import {
    capSubagentText,
    parseTaskNotificationText,
    shouldEmitProgress,
    toolUseResultStats,
    toolUseResultStatus,
    toolUseResultToText,
    type ProgressThrottleState,
} from './subagentLifecycle';

export type ClaudeSessionProtocolState = {
    currentTurnId: string | null;
    pendingAssistantError?: string;
    uuidToProviderSubagent?: Map<string, string>;
    taskPromptToSubagents?: Map<string, string[]>;
    providerSubagentToSessionSubagent?: Map<string, string>;
    subagentTitles?: Map<string, string>;
    bufferedSubagentMessages?: Map<string, RawJSONLines[]>;
    hiddenParentToolCalls?: Set<string>;
    startedSubagents?: Set<string>;
    activeSubagents?: Set<string>;
    // B-260-P2 lifecycle state (survives closeTurn — background sub-agents
    // outlive the turn that launched them).
    /** tool_use ids of Agent/Task calls seen in this process. */
    agentToolCalls?: Set<string>;
    /** Identity captured from the Agent input / task_started. */
    subagentMeta?: Map<string, { description?: string; subagentType?: string }>;
    /** Sub-agents whose tool_result was the async stub — their stop comes from task_notification. */
    stubSubagents?: Set<string>;
    progressThrottle?: Map<string, ProgressThrottleState>;
    /** Injectable clock for tests. */
    now?: () => number;
};

const SUBAGENT_BUFFER_MAX_MESSAGES = 100;

type ClaudeMapperResult = {
    currentTurnId: string | null;
    envelopes: SessionEnvelope[];
};

function isSubagentTool(name: string): boolean {
    return name === 'Task' || name === 'Agent';
}

function shouldHideParentToolCall(name: string): boolean {
    return name === 'Task';
}

function pickProviderSubagent(message: RawJSONLines): string | undefined {
    const raw = message as { parent_tool_use_id?: unknown; parentToolUseId?: unknown };
    if (typeof raw.parent_tool_use_id === 'string' && raw.parent_tool_use_id.length > 0) {
        return raw.parent_tool_use_id;
    }
    if (typeof raw.parentToolUseId === 'string' && raw.parentToolUseId.length > 0) {
        return raw.parentToolUseId;
    }
    return undefined;
}

function getUuidToProviderSubagent(state: ClaudeSessionProtocolState): Map<string, string> {
    if (!state.uuidToProviderSubagent) {
        state.uuidToProviderSubagent = new Map<string, string>();
    }
    return state.uuidToProviderSubagent;
}

function getTaskPromptToSubagents(state: ClaudeSessionProtocolState): Map<string, string[]> {
    if (!state.taskPromptToSubagents) {
        state.taskPromptToSubagents = new Map<string, string[]>();
    }
    return state.taskPromptToSubagents;
}

function getProviderSubagentToSessionSubagent(state: ClaudeSessionProtocolState): Map<string, string> {
    if (!state.providerSubagentToSessionSubagent) {
        state.providerSubagentToSessionSubagent = new Map<string, string>();
    }
    return state.providerSubagentToSessionSubagent;
}

function getSessionSubagentIdForProviderSubagent(
    state: ClaudeSessionProtocolState,
    providerSubagent: string,
): string | undefined {
    return getProviderSubagentToSessionSubagent(state).get(providerSubagent);
}

function ensureSessionSubagentIdForProviderSubagent(
    state: ClaudeSessionProtocolState,
    providerSubagent: string,
): string {
    const existing = getSessionSubagentIdForProviderSubagent(state, providerSubagent);
    if (existing) {
        return existing;
    }

    const created = createId();
    getProviderSubagentToSessionSubagent(state).set(providerSubagent, created);
    return created;
}

function getSubagentTitles(state: ClaudeSessionProtocolState): Map<string, string> {
    if (!state.subagentTitles) {
        state.subagentTitles = new Map<string, string>();
    }
    return state.subagentTitles;
}

function getBufferedSubagentMessages(state: ClaudeSessionProtocolState): Map<string, RawJSONLines[]> {
    if (!state.bufferedSubagentMessages) {
        state.bufferedSubagentMessages = new Map<string, RawJSONLines[]>();
    }
    return state.bufferedSubagentMessages;
}

function getHiddenParentToolCalls(state: ClaudeSessionProtocolState): Set<string> {
    if (!state.hiddenParentToolCalls) {
        state.hiddenParentToolCalls = new Set<string>();
    }
    return state.hiddenParentToolCalls;
}

function bufferSubagentMessage(state: ClaudeSessionProtocolState, subagent: string, message: RawJSONLines): void {
    const buffer = getBufferedSubagentMessages(state);
    const queue = buffer.get(subagent) ?? [];
    queue.push(message);
    // B-260-P2: bounded — a parent that never shows up must not grow memory forever.
    while (queue.length > SUBAGENT_BUFFER_MAX_MESSAGES) queue.shift();
    buffer.set(subagent, queue);
}

function consumeBufferedSubagentMessages(state: ClaudeSessionProtocolState, subagent: string): RawJSONLines[] {
    const buffer = getBufferedSubagentMessages(state);
    const queue = buffer.get(subagent) ?? [];
    buffer.delete(subagent);
    return queue;
}

function getStartedSubagents(state: ClaudeSessionProtocolState): Set<string> {
    if (!state.startedSubagents) {
        state.startedSubagents = new Set<string>();
    }
    return state.startedSubagents;
}

function getActiveSubagents(state: ClaudeSessionProtocolState): Set<string> {
    if (!state.activeSubagents) {
        state.activeSubagents = new Set<string>();
    }
    return state.activeSubagents;
}

function getAgentToolCalls(state: ClaudeSessionProtocolState): Set<string> {
    if (!state.agentToolCalls) state.agentToolCalls = new Set<string>();
    return state.agentToolCalls;
}

function getSubagentMeta(state: ClaudeSessionProtocolState): Map<string, { description?: string; subagentType?: string }> {
    if (!state.subagentMeta) state.subagentMeta = new Map();
    return state.subagentMeta;
}

function getStubSubagents(state: ClaudeSessionProtocolState): Set<string> {
    if (!state.stubSubagents) state.stubSubagents = new Set<string>();
    return state.stubSubagents;
}

function getProgressThrottle(state: ClaudeSessionProtocolState): Map<string, ProgressThrottleState> {
    if (!state.progressThrottle) state.progressThrottle = new Map();
    return state.progressThrottle;
}

function nowOf(state: ClaudeSessionProtocolState): number {
    return state.now ? state.now() : Date.now();
}

function rememberSubagentMeta(state: ClaudeSessionProtocolState, subagent: string, meta: { description?: unknown; subagentType?: unknown }): void {
    const existing = getSubagentMeta(state).get(subagent) ?? {};
    const description = typeof meta.description === 'string' && meta.description.trim() ? meta.description.trim() : existing.description;
    const subagentType = typeof meta.subagentType === 'string' && meta.subagentType.trim() ? meta.subagentType.trim() : existing.subagentType;
    getSubagentMeta(state).set(subagent, { ...(description ? { description } : {}), ...(subagentType ? { subagentType } : {}) });
}

/** Per-API-call usage of an assistant transcript line, in the wire shape
 *  (B-108). Only assistant lines carry usage; malformed shapes are dropped.
 *  Stamped onto EVERY envelope the line maps to — the web keeps the newest
 *  by timestamp, so duplicates are harmless — because a tool-only line has
 *  no text envelope to be picky about. */
function pickAssistantUsage(message: RawJSONLines): { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | undefined {
    if (message.type !== 'assistant') return undefined;
    const usage = message.message?.usage;
    if (!usage || typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return undefined;
    return {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        ...(typeof usage.cache_creation_input_tokens === 'number' ? { cache_creation_input_tokens: usage.cache_creation_input_tokens } : {}),
        ...(typeof usage.cache_read_input_tokens === 'number' ? { cache_read_input_tokens: usage.cache_read_input_tokens } : {}),
    };
}

function pickUuid(message: RawJSONLines): string | undefined {
    const raw = message as { uuid?: unknown };
    if (typeof raw.uuid === 'string' && raw.uuid.length > 0) {
        return raw.uuid;
    }
    return undefined;
}

function pickParentUuid(message: RawJSONLines): string | undefined {
    const raw = message as { parentUuid?: unknown; parentUUID?: unknown };
    if (typeof raw.parentUuid === 'string' && raw.parentUuid.length > 0) {
        return raw.parentUuid;
    }
    if (typeof raw.parentUUID === 'string' && raw.parentUUID.length > 0) {
        return raw.parentUUID;
    }
    return undefined;
}

function isSidechainMessage(message: RawJSONLines): boolean {
    const raw = message as { isSidechain?: unknown };
    return raw.isSidechain === true;
}

function normalizePrompt(prompt: string): string {
    return prompt.trim();
}

function queueTaskPromptSubagent(state: ClaudeSessionProtocolState, prompt: string, subagent: string): void {
    const normalized = normalizePrompt(prompt);
    if (normalized.length === 0) {
        return;
    }

    const promptMap = getTaskPromptToSubagents(state);
    const queue = promptMap.get(normalized) ?? [];
    if (!queue.includes(subagent)) {
        queue.push(subagent);
    }
    promptMap.set(normalized, queue);
}

function consumeTaskPromptSubagent(state: ClaudeSessionProtocolState, prompt: string): string | undefined {
    const normalized = normalizePrompt(prompt);
    if (normalized.length === 0) {
        return undefined;
    }

    const promptMap = getTaskPromptToSubagents(state);
    const queue = promptMap.get(normalized);
    if (!queue || queue.length === 0) {
        return undefined;
    }

    const subagent = queue.shift();
    if (queue.length === 0) {
        promptMap.delete(normalized);
    }
    return subagent;
}

function consumeSinglePendingTaskSubagent(state: ClaudeSessionProtocolState): string | undefined {
    const promptMap = getTaskPromptToSubagents(state);
    let candidateKey: string | null = null;
    let candidateSubagent: string | null = null;

    for (const [prompt, queue] of promptMap.entries()) {
        if (queue.length === 0) {
            continue;
        }

        if (candidateKey !== null) {
            return undefined;
        }

        candidateKey = prompt;
        candidateSubagent = queue[0] ?? null;
    }

    if (!candidateKey || !candidateSubagent) {
        return undefined;
    }

    const queue = promptMap.get(candidateKey);
    if (!queue || queue.length === 0) {
        return undefined;
    }

    queue.shift();
    if (queue.length === 0) {
        promptMap.delete(candidateKey);
    }

    return candidateSubagent;
}

function pickSidechainRootPrompt(message: RawJSONLines): string | undefined {
    if (message.type !== 'user') {
        return undefined;
    }

    if (typeof message.message?.content === 'string') {
        const normalized = normalizePrompt(message.message.content);
        return normalized.length > 0 ? normalized : undefined;
    }

    return undefined;
}

function resolveProviderSubagent(message: RawJSONLines, state: ClaudeSessionProtocolState): string | undefined {
    const explicitSubagent = pickProviderSubagent(message);
    if (explicitSubagent) {
        return explicitSubagent;
    }

    const parentUuid = pickParentUuid(message);
    if (parentUuid) {
        const inheritedSubagent = getUuidToProviderSubagent(state).get(parentUuid);
        if (inheritedSubagent) {
            return inheritedSubagent;
        }
    }

    if (!isSidechainMessage(message)) {
        return undefined;
    }

    const prompt = pickSidechainRootPrompt(message);
    if (prompt) {
        const matchedSubagent = consumeTaskPromptSubagent(state, prompt);
        if (matchedSubagent) {
            return matchedSubagent;
        }
    }

    if (!parentUuid) {
        return consumeSinglePendingTaskSubagent(state);
    }

    return undefined;
}

function rememberSubagentForMessage(message: RawJSONLines, state: ClaudeSessionProtocolState, providerSubagent: string | undefined): void {
    if (!providerSubagent) {
        return;
    }

    const uuid = pickUuid(message);
    if (!uuid) {
        return;
    }

    getUuidToProviderSubagent(state).set(uuid, providerSubagent);
}

function pickTaskPrompt(input: unknown): string | undefined {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return undefined;
    }

    const prompt = (input as { prompt?: unknown }).prompt;
    if (typeof prompt !== 'string') {
        return undefined;
    }

    const normalized = normalizePrompt(prompt);
    return normalized.length > 0 ? normalized : undefined;
}

function pickTaskTitle(input: unknown): string | undefined {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return undefined;
    }

    const candidateKeys = ['description', 'title', 'subagent_type'];
    for (const key of candidateKeys) {
        const value = (input as Record<string, unknown>)[key];
        if (typeof value === 'string' && value.trim().length > 0) {
            return value.trim();
        }
    }

    return undefined;
}

function setSubagentTitle(state: ClaudeSessionProtocolState, subagent: string, title: string | undefined): void {
    if (!title || title.trim().length === 0) {
        return;
    }
    getSubagentTitles(state).set(subagent, title.trim());
}

function maybeEmitSubagentStart(
    state: ClaudeSessionProtocolState,
    turn: string,
    subagent: string | undefined,
    envelopes: SessionEnvelope[],
): void {
    if (!subagent) {
        return;
    }

    const started = getStartedSubagents(state);
    if (started.has(subagent)) {
        return;
    }

    const title = getSubagentTitles(state).get(subagent);
    const meta = getSubagentMeta(state).get(subagent);
    envelopes.push(createEnvelope('agent', {
        t: 'start',
        ...(title ? { title } : {}),
        ...(meta?.description ? { description: meta.description } : {}),
        ...(meta?.subagentType ? { subagentType: meta.subagentType } : {}),
    }, { turn, subagent }));
    started.add(subagent);
    getActiveSubagents(state).add(subagent);
}

/** B-260-P2: stop with lifecycle payload; may be emitted twice (status first, result later). */
function emitSubagentStopWithStatus(
    state: ClaudeSessionProtocolState,
    turn: string | undefined,
    subagent: string,
    envelopes: SessionEnvelope[],
    payload: { status?: 'completed' | 'failed' | 'stopped'; result?: { text: string; truncated?: boolean }; usage?: { toolUses?: number; totalTokens?: number; durationMs?: number } },
): void {
    envelopes.push(createEnvelope('agent', {
        t: 'stop',
        ...(payload.status ? { status: payload.status } : {}),
        ...(payload.result ? { result: payload.result } : {}),
        ...(payload.usage ? { usage: payload.usage } : {}),
    }, { ...(turn ? { turn } : {}), subagent }));
    getActiveSubagents(state).delete(subagent);
    getStartedSubagents(state).delete(subagent);
}

function maybeEmitSubagentStop(
    state: ClaudeSessionProtocolState,
    turn: string,
    subagent: string,
    envelopes: SessionEnvelope[],
): void {
    const active = getActiveSubagents(state);
    if (!active.has(subagent)) {
        return;
    }

    envelopes.push(createEnvelope('agent', { t: 'stop' }, { turn, subagent }));
    active.delete(subagent);
}

function clearSubagentTracking(state: ClaudeSessionProtocolState): void {
    getUuidToProviderSubagent(state).clear();
    getTaskPromptToSubagents(state).clear();
    // B-260-P2: the provider→session subagent mapping, titles and identity
    // deliberately SURVIVE the turn: background sub-agents keep sending
    // child messages and their task_notification after the launching turn
    // ended; releasing the mapping here buffered those forever (data loss).
    getBufferedSubagentMessages(state).clear();
    getHiddenParentToolCalls(state).clear();
    getStartedSubagents(state).clear();
    getActiveSubagents(state).clear();
}

function ensureTurn(state: ClaudeSessionProtocolState, envelopes: SessionEnvelope[]): string {
    if (state.currentTurnId) {
        return state.currentTurnId;
    }

    const turnId = createId();
    envelopes.push(createEnvelope('agent', { t: 'turn-start' }, { turn: turnId }));
    state.currentTurnId = turnId;
    return turnId;
}

type TurnEndMeta = {
    error?: string;
    costUsd?: number;
    durationMs?: number;
    numTurns?: number;
    usage?: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
    };
};

function closeTurn(
    state: ClaudeSessionProtocolState,
    status: SessionTurnEndStatus,
    envelopes: SessionEnvelope[],
    meta?: TurnEndMeta,
): void {
    if (!state.currentTurnId) {
        return;
    }

    envelopes.push(createEnvelope('agent', {
        t: 'turn-end',
        status,
        ...(meta?.error ? { error: meta.error } : {}),
        ...(typeof meta?.costUsd === 'number' ? { costUsd: meta.costUsd } : {}),
        ...(typeof meta?.durationMs === 'number' ? { durationMs: meta.durationMs } : {}),
        ...(typeof meta?.numTurns === 'number' ? { numTurns: meta.numTurns } : {}),
        ...(meta?.usage ? { usage: meta.usage } : {}),
    }, { turn: state.currentTurnId }));
    state.currentTurnId = null;
    state.pendingAssistantError = undefined;
    clearSubagentTracking(state);
}

function toolTitle(name: string, input: unknown): string {
    if (input && typeof input === 'object') {
        const description = (input as { description?: unknown }).description;
        if (typeof description === 'string' && description.trim().length > 0) {
            return description.length > 80 ? `${description.slice(0, 77)}...` : description;
        }
    }
    return `${name} call`;
}

function toToolArgs(input: unknown): Record<string, unknown> {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
        return input as Record<string, unknown>;
    }
    if (input === undefined) {
        return {};
    }
    return { input };
}

export function closeClaudeTurnWithStatus(
    state: ClaudeSessionProtocolState,
    status: SessionTurnEndStatus,
    meta?: TurnEndMeta,
): ClaudeMapperResult {
    const envelopes: SessionEnvelope[] = [];
    closeTurn(state, status, envelopes, meta);
    return {
        currentTurnId: state.currentTurnId,
        envelopes,
    };
}

export function mapClaudeLogMessageToSessionEnvelopes(
    message: RawJSONLines,
    state: ClaudeSessionProtocolState,
): ClaudeMapperResult {
    return mapClaudeLogMessageToSessionEnvelopesInternal(message, state);
}

/**
 * B-260-P2: SDK system/task_* frames → sub-agent lifecycle envelopes. Only
 * frames whose tool_use_id points at an Agent/Task call THIS process saw are
 * mapped; Bash background tasks, Monitor events and skip_transcript tasks are
 * ignored (they still reach the user as the notification machine line).
 */
function mapTaskLifecycleSystemMessage(
    message: RawJSONLines,
    state: ClaudeSessionProtocolState,
    envelopes: SessionEnvelope[],
): void {
    const raw = message as RawJSONLines & {
        subtype?: unknown;
        tool_use_id?: unknown;
        description?: unknown;
        subagent_type?: unknown;
        skip_transcript?: unknown;
        status?: unknown;
        usage?: { total_tokens?: unknown; tool_uses?: unknown; duration_ms?: unknown };
        last_tool_name?: unknown;
        summary?: unknown;
        patch?: { is_backgrounded?: unknown };
    };
    const subtype = typeof raw.subtype === 'string' ? raw.subtype : '';
    if (!subtype.startsWith('task_')) return;
    if (raw.skip_transcript === true) return;
    const toolUseId = typeof raw.tool_use_id === 'string' && raw.tool_use_id.length > 0 ? raw.tool_use_id : null;
    if (!toolUseId || !getAgentToolCalls(state).has(toolUseId)) return;
    const subagent = ensureSessionSubagentIdForProviderSubagent(state, toolUseId);
    const usage = raw.usage && typeof raw.usage === 'object'
        ? {
            ...(typeof raw.usage.tool_uses === 'number' ? { toolUses: raw.usage.tool_uses } : {}),
            ...(typeof raw.usage.total_tokens === 'number' ? { totalTokens: raw.usage.total_tokens } : {}),
            ...(typeof raw.usage.duration_ms === 'number' ? { durationMs: raw.usage.duration_ms } : {}),
        }
        : undefined;

    if (subtype === 'task_started') {
        rememberSubagentMeta(state, subagent, { description: raw.description, subagentType: raw.subagent_type });
        const turn = ensureTurn(state, envelopes);
        // A resumed sub-agent (same tool_use_id notifies again) comes back to
        // running: drop it from the started set so start is re-emitted.
        getStartedSubagents(state).delete(subagent);
        maybeEmitSubagentStart(state, turn, subagent, envelopes);
        return;
    }
    if (subtype === 'task_progress') {
        const toolUses = typeof raw.usage?.tool_uses === 'number' ? raw.usage.tool_uses : 0;
        const throttle = getProgressThrottle(state);
        const now = nowOf(state);
        if (!shouldEmitProgress(throttle.get(subagent), toolUses, now)) return;
        throttle.set(subagent, { lastAt: now, lastToolUses: toolUses });
        const turn = ensureTurn(state, envelopes);
        maybeEmitSubagentStart(state, turn, subagent, envelopes);
        envelopes.push(createEnvelope('agent', {
            t: 'progress',
            toolUses,
            ...(typeof raw.last_tool_name === 'string' && raw.last_tool_name ? { lastTool: raw.last_tool_name } : {}),
            ...(usage?.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
            ...(usage?.durationMs !== undefined ? { durationMs: usage.durationMs } : {}),
            ...(typeof raw.summary === 'string' && raw.summary.trim() ? { summary: raw.summary.trim() } : {}),
        }, { turn, subagent }));
        return;
    }
    if (subtype === 'task_notification') {
        const status = raw.status === 'completed' || raw.status === 'failed' || raw.status === 'stopped' ? raw.status : 'completed';
        emitSubagentStopWithStatus(state, state.currentTurnId ?? undefined, subagent, envelopes, {
            status,
            ...(usage ? { usage } : {}),
        });
        getStubSubagents(state).delete(subagent);
        getProgressThrottle(state).delete(subagent);
        return;
    }
    if (subtype === 'task_updated' && raw.patch?.is_backgrounded === true) {
        getStubSubagents(state).add(subagent);
    }
}

function mapClaudeLogMessageToSessionEnvelopesInternal(
    message: RawJSONLines,
    state: ClaudeSessionProtocolState,
): ClaudeMapperResult {
    const envelopes: SessionEnvelope[] = [];
    const claudeUuid = pickUuid(message);
    const providerSubagent = resolveProviderSubagent(message, state);
    const subagent = providerSubagent
        ? getSessionSubagentIdForProviderSubagent(state, providerSubagent)
        : undefined;
    rememberSubagentForMessage(message, state, providerSubagent);

    if (providerSubagent && !subagent) {
        bufferSubagentMessage(state, providerSubagent, message);
        return {
            currentTurnId: state.currentTurnId,
            envelopes: [],
        };
    }

    if (message.type === 'summary') {
        return {
            currentTurnId: state.currentTurnId,
            envelopes,
        };
    }

    if (message.type === 'system') {
        mapTaskLifecycleSystemMessage(message, state, envelopes);
        return {
            currentTurnId: state.currentTurnId,
            envelopes,
        };
    }

    if ((message as any).isCompactSummary) {
        return {
            currentTurnId: state.currentTurnId,
            envelopes,
        };
    }

    if (message.type === 'assistant') {
        const assistantError = (message as RawJSONLines & { error?: unknown }).error;
        if (!message.isSidechain && typeof assistantError === 'string' && assistantError.trim()) {
            state.pendingAssistantError = assistantError.trim();
        }
        const turnId = ensureTurn(state, envelopes);
        maybeEmitSubagentStart(state, turnId, subagent, envelopes);
        const usage = pickAssistantUsage(message);
        const blocks = Array.isArray(message.message?.content) ? message.message.content : [];

        for (const block of blocks) {
            if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
                envelopes.push(createEnvelope('agent', { t: 'text', text: block.text }, { turn: turnId, subagent, claudeUuid, usage }));
                continue;
            }

            if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim().length > 0) {
                envelopes.push(createEnvelope('agent', { t: 'text', text: block.thinking, thinking: true }, { turn: turnId, subagent, claudeUuid, usage }));
                continue;
            }

            if (block.type === 'tool_use') {
                const call = typeof block.id === 'string' && block.id.length > 0 ? block.id : createId();
                const name = typeof block.name === 'string' && block.name.length > 0 ? block.name : 'unknown';
                const baseArgs = toToolArgs(block.input);
                const title = toolTitle(name, block.input);
                const sessionSubagentForCall = ensureSessionSubagentIdForProviderSubagent(state, call);
                if (isSubagentTool(name)) {
                    const prompt = pickTaskPrompt(block.input);
                    if (prompt) {
                        queueTaskPromptSubagent(state, prompt, call);
                    }
                    setSubagentTitle(state, sessionSubagentForCall, pickTaskTitle(block.input) ?? prompt);
                    getAgentToolCalls(state).add(call);
                    const input = (block.input ?? {}) as { description?: unknown; subagent_type?: unknown };
                    rememberSubagentMeta(state, sessionSubagentForCall, { description: input.description, subagentType: input.subagent_type });
                }
                if (shouldHideParentToolCall(name)) {
                    getHiddenParentToolCalls(state).add(call);

                    const buffered = consumeBufferedSubagentMessages(state, call);
                    for (const bufferedMessage of buffered) {
                        const replay = mapClaudeLogMessageToSessionEnvelopesInternal(bufferedMessage, state);
                        envelopes.push(...replay.envelopes);
                    }
                    continue;
                }
                const args = isSubagentTool(name)
                    ? { ...baseArgs, sessionSubagent: sessionSubagentForCall }
                    : baseArgs;

                envelopes.push(createEnvelope('agent', {
                    t: 'tool-call-start',
                    call,
                    name,
                    title,
                    description: title,
                    args,
                }, { turn: turnId, subagent, usage }));
                const buffered = consumeBufferedSubagentMessages(state, call);
                for (const bufferedMessage of buffered) {
                    const replay = mapClaudeLogMessageToSessionEnvelopesInternal(bufferedMessage, state);
                    envelopes.push(...replay.envelopes);
                }
            }
        }

        return {
            currentTurnId: state.currentTurnId,
            envelopes,
        };
    }

    if (message.type === 'user') {
        // SDK-injected synthetic user messages (e.g. the Skill tool feeds
        // the skill prompt back to Claude as a 'user' message with
        // isMeta=true so the model sees it but the human shouldn't).
        // Without this skip the prompt body — easily 10–20k characters —
        // gets emitted as an agent-text envelope and lands in the chat as
        // a wall of text.
        if (message.isMeta) {
            return {
                currentTurnId: state.currentTurnId,
                envelopes,
            };
        }
        if (typeof message.message.content === 'string') {
            if (message.isSidechain) {
                const turnId = ensureTurn(state, envelopes);
                maybeEmitSubagentStart(state, turnId, subagent, envelopes);
                envelopes.push(createEnvelope('agent', { t: 'text', text: message.message.content }, { turn: turnId, subagent, claudeUuid }));
            } else {
                // B-260-P2: the task-notification user message carries the
                // sub-agent's final report (<result>). Emit the lifecycle stop
                // (again, with result) BEFORE the turn boundary so it lands in
                // the launching turn's card; the user text itself stays a turn
                // boundary (the web renders it as a machine line).
                const origin = (message as { origin?: { kind?: unknown } }).origin;
                if (origin?.kind === 'task-notification' || /<task-notification>/i.test(message.message.content)) {
                    const fields = parseTaskNotificationText(message.message.content);
                    const providerId = fields?.toolUseId ?? null;
                    const subagentForNotification = providerId && getAgentToolCalls(state).has(providerId)
                        ? getSessionSubagentIdForProviderSubagent(state, providerId)
                        : undefined;
                    if (fields && subagentForNotification && (fields.result || fields.status)) {
                        emitSubagentStopWithStatus(state, state.currentTurnId ?? undefined, subagentForNotification, envelopes, {
                            ...(fields.status ? { status: fields.status } : {}),
                            ...(fields.result ? { result: fields.result } : {}),
                        });
                    }
                }
                closeTurn(state, 'completed', envelopes);
                envelopes.push(createEnvelope('user', { t: 'text', text: message.message.content }, { claudeUuid }));
            }

            return {
                currentTurnId: state.currentTurnId,
                envelopes,
            };
        }

        const blocks = Array.isArray(message.message.content) ? message.message.content : [];
        if (blocks.length === 0) {
            return {
                currentTurnId: state.currentTurnId,
                envelopes,
            };
        }

        const turnId = ensureTurn(state, envelopes);
        if (message.isSidechain) {
            maybeEmitSubagentStart(state, turnId, subagent, envelopes);
        }
        for (const block of blocks) {
            if (block.type === 'tool_result' && typeof block.tool_use_id === 'string' && block.tool_use_id.length > 0) {
                const sessionSubagentForToolResult = getSessionSubagentIdForProviderSubagent(state, block.tool_use_id);
                if (!message.isSidechain) {
                    if (getHiddenParentToolCalls(state).has(block.tool_use_id)) {
                        if (sessionSubagentForToolResult) {
                            maybeEmitSubagentStop(state, turnId, sessionSubagentForToolResult, envelopes);
                        }
                        getHiddenParentToolCalls(state).delete(block.tool_use_id);
                        continue;
                    }
                    if (sessionSubagentForToolResult && getAgentToolCalls(state).has(block.tool_use_id)) {
                        // B-260-P2: an Agent tool_result is either the async stub
                        // (sub-agent keeps running; its stop comes from
                        // task_notification) or the foreground final report.
                        const toolUseResult = (message as { tool_use_result?: unknown }).tool_use_result;
                        const resultStatus = toolUseResultStatus(toolUseResult);
                        if (resultStatus === 'async_launched') {
                            getStubSubagents(state).add(sessionSubagentForToolResult);
                            envelopes.push(createEnvelope('agent', { t: 'tool-call-end', call: block.tool_use_id }, { turn: turnId, subagent }));
                            continue;
                        }
                        if (resultStatus === 'completed') {
                            const text = toolUseResultToText(toolUseResult);
                            const stats = toolUseResultStats(toolUseResult);
                            const result = text ? capSubagentText(text) : undefined;
                            emitSubagentStopWithStatus(state, turnId, sessionSubagentForToolResult, envelopes, {
                                status: 'completed',
                                ...(result ? { result } : {}),
                                ...(stats ? { usage: { toolUses: stats.toolUses, totalTokens: stats.totalTokens, durationMs: stats.durationMs } } : {}),
                            });
                            envelopes.push(createEnvelope('agent', {
                                t: 'tool-call-end',
                                call: block.tool_use_id,
                                ...(result ? { result: { ...result, ...(stats ? { stats } : {}) } } : {}),
                            }, { turn: turnId, subagent }));
                            continue;
                        }
                    }
                    if (sessionSubagentForToolResult) {
                        maybeEmitSubagentStop(state, turnId, sessionSubagentForToolResult, envelopes);
                    }
                }
                envelopes.push(createEnvelope('agent', {
                    t: 'tool-call-end',
                    call: block.tool_use_id,
                }, { turn: turnId, subagent }));
                continue;
            }

            if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
                envelopes.push(createEnvelope('agent', { t: 'text', text: block.text }, { turn: turnId, subagent, claudeUuid }));
            }
        }

        return {
            currentTurnId: state.currentTurnId,
            envelopes,
        };
    }

    if (message.type === 'result') {
        // The SDK result message marks turn completion and carries the
        // per-turn cost / duration / turn count / usage. Close the current
        // turn and stamp the metadata onto the turn-end envelope so the app
        // can render it at the end of the turn.
        const raw = message as RawJSONLines & {
            subtype?: string;
            is_error?: boolean;
            interrupted?: boolean;
            errors?: string[];
            total_cost_usd?: number;
            duration_ms?: number;
            num_turns?: number;
            usage?: {
                input_tokens?: number;
                output_tokens?: number;
                cache_creation_input_tokens?: number;
                cache_read_input_tokens?: number;
            };
        };
        const status: SessionTurnEndStatus = raw.interrupted === true
            ? 'cancelled'
            : raw.is_error === true ? 'failed' : 'completed';
        const error = status === 'failed'
            ? raw.errors?.filter((item) => typeof item === 'string' && item.trim()).join('\n')
                || state.pendingAssistantError
                || raw.subtype
                || 'Claude turn failed'
            : undefined;
        // Startup/transport failures can produce a result before any
        // assistant frame. Create a minimal turn so the failed lifecycle and
        // its error are still visible instead of being dropped by closeTurn.
        if (status === 'failed' && !state.currentTurnId) {
            ensureTurn(state, envelopes);
        }
        const usage = raw.usage && typeof raw.usage.input_tokens === 'number' && typeof raw.usage.output_tokens === 'number'
            ? {
                input_tokens: raw.usage.input_tokens,
                output_tokens: raw.usage.output_tokens,
                ...(typeof raw.usage.cache_creation_input_tokens === 'number' ? { cache_creation_input_tokens: raw.usage.cache_creation_input_tokens } : {}),
                ...(typeof raw.usage.cache_read_input_tokens === 'number' ? { cache_read_input_tokens: raw.usage.cache_read_input_tokens } : {}),
            }
            : undefined;
        closeTurn(state, status, envelopes, {
            error,
            costUsd: typeof raw.total_cost_usd === 'number' ? raw.total_cost_usd : undefined,
            durationMs: typeof raw.duration_ms === 'number' ? raw.duration_ms : undefined,
            numTurns: typeof raw.num_turns === 'number' ? raw.num_turns : undefined,
            usage,
        });
        return {
            currentTurnId: state.currentTurnId,
            envelopes,
        };
    }

    return {
        currentTurnId: state.currentTurnId,
        envelopes,
    };
}
