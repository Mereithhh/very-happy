/**
 * Message Reducer for Real-time Sync System
 * 
 * This reducer is the core message processing engine that transforms raw messages from
 * the sync system into a structured, deduplicated message history. It handles complex
 * scenarios including tool permissions, sidechains, and message deduplication.
 * 
 * ## Core Responsibilities:
 * 
 * 1. **Message Deduplication**: Prevents duplicate messages using multiple tracking mechanisms:
 *    - localId tracking for user messages
 *    - messageId tracking for all messages
 *    - Permission ID tracking for tool permissions
 * 
 * 2. **Tool Permission Management**: Integrates with AgentState to handle tool permissions:
 *    - Creates placeholder messages for pending permission requests
 *    - Updates permission status (pending → approved/denied/canceled)
 *    - Matches incoming tool calls to approved permissions
 *    - Prioritizes tool calls over permissions when both exist
 * 
 * 3. **Tool Call Lifecycle**: Manages the complete lifecycle of tool calls:
 *    - Creation from permission requests or direct tool calls
 *    - Matching tool calls to existing permission messages
 *    - Processing tool results and updating states
 *    - Handling errors and completion states
 * 
 * 4. **Sidechain Processing**: Handles nested conversation branches (sidechains):
 *    - Identifies sidechain messages using the tracer
 *    - Stores sidechain messages separately
 *    - Links sidechains to their parent tool calls
 * 
 * ## Processing Phases:
 * 
 * The reducer processes messages in a specific order to ensure correct behavior:
 * 
 * **Phase 0: AgentState Permissions**
 *   - Processes pending and completed permission requests
 *   - Creates tool messages for permissions
 *   - Skips completed permissions if matching tool call (same name AND arguments) exists in incoming messages
 *   - Phase 2 will handle matching tool calls to existing permission messages
 * 
 * **Phase 0.5: Message-to-Event Conversion**
 *   - Parses messages to check if they should be converted to events
 *   - Converts matching messages to events immediately
 *   - Converted messages skip all subsequent processing phases
 *   - Supports user commands, tool results, and metadata-driven conversions
 * 
 * **Phase 1: User and Text Messages**
 *   - Processes user messages with deduplication
 *   - Processes agent text messages
 *   - Skips tool calls for later phases
 * 
 * **Phase 2: Tool Calls**
 *   - Processes incoming tool calls from agents
 *   - Matches to existing permission messages when possible
 *   - Creates new tool messages when no match exists
 *   - Prioritizes newest permission when multiple matches
 * 
 * **Phase 3: Tool Results**
 *   - Updates tool messages with results
 *   - Sets completion or error states
 *   - Updates completion timestamps
 * 
 * **Phase 4: Sidechains**
 *   - Processes sidechain messages separately
 *   - Stores in sidechain map linked to parent tool
 *   - Handles nested tool calls within sidechains
 * 
 * **Phase 5: Mode Switch Events**
 *   - Processes agent event messages
 *   - Handles mode changes and other events
 * 
 * ## Key Behaviors:
 * 
 * - **Idempotency**: Calling the reducer multiple times with the same data produces no duplicates
 * - **Priority Rules**: When both tool calls and permissions exist, tool calls take priority
 * - **Argument Matching**: Tool calls match to permissions based on both name AND arguments
 * - **Timestamp Preservation**: Original timestamps are preserved when matching tools to permissions
 * - **State Persistence**: The ReducerState maintains all mappings across calls
 * - **Message Immutability**: NEVER modify message timestamps or core properties after creation
 *   Messages can only have their tool state/result updated, never their creation metadata
 * - **Timestamp Preservation**: NEVER change a message's createdAt timestamp. The timestamp
 *   represents when the message was originally created and must be preserved throughout all
 *   processing phases. This is critical for maintaining correct message ordering.
 * 
 * ## Permission Matching Algorithm:
 * 
 * When a tool call arrives, the matching algorithm:
 * 1. Checks if the tool has already been processed (via toolIdToMessageId)
 * 2. Searches for approved permission messages with:
 *    - Same tool name
 *    - Matching arguments (deep equality)
 *    - Not already linked to another tool
 * 3. Prioritizes the newest matching permission
 * 4. Updates the permission message with tool execution details
 * 5. Falls back to creating a new tool message if no match
 * 
 * ## Data Flow:
 * 
 * Raw Messages → Normalizer → Reducer → Structured Messages
 *                              ↑
 *                         AgentState
 * 
 * The reducer receives:
 * - Normalized messages from the sync system
 * - Current AgentState with permission information
 * 
 * And produces:
 * - Structured Message objects for UI rendering
 * - Updated internal state for future processing
 */

import { Message, ToolCall } from "../typesMessage";
import { AgentEvent, NormalizedMessage, UsageData } from "../typesRaw";
import { createTracer, traceMessages, TracerState } from "./reducerTracer";
import { AgentState, TodoItem, TodoItemsSchema } from "../storageTypes";
import { MessageMeta } from "../typesMessageMeta";
import { parseMessageAsEvent } from "./messageToEvent";
import { firstTurnEndForQueuedInput, TurnEndBoundary } from "../queuedInput";

type TurnUsage = {
    inputTokens: number;
    outputTokens: number;
    cacheCreation?: number;
    cacheRead?: number;
};

type ReducerMessage = {
    id: string;
    realID: string | null;
    createdAt: number;
    /**
     * Server-assigned sequence number of the source message (conversation
     * order). Undefined for messages synthesized locally (agent-state
     * permission requests, optimistic sends). Primary ordering key for
     * rendering — createdAt ties are common because the server stamps a
     * whole POSTed batch with one transaction timestamp.
     */
    seq?: number | null;
    /**
     * Monotonic creation counter within this reducer state. Last-resort
     * ordering tiebreaker when both seq and createdAt tie (e.g. several
     * blocks of one source message, which share seq and createdAt).
     */
    sortOrder: number;
    role: 'user' | 'agent';
    localId?: string | null;
    inputState?: 'queued';
    displaySeq?: number | null;
    displayAt?: number;
    text: string | null;
    isThinking?: boolean;
    event: AgentEvent | null;
    tool: ToolCall | null;
    meta?: MessageMeta;
    claudeUuid?: string;
    codexItemId?: string;
    // Per-turn metadata. `usage` is the per-message usage from the assistant
    // message itself; cost/duration/numTurns are stamped from the SDK result
    // (turn-end) onto the turn's final agent-text message.
    usage?: TurnUsage;
    costUsd?: number;
    totalDurationMs?: number;
    numTurns?: number;
}

type StoredPermission = {
    tool: string;
    arguments: any;
    createdAt: number;
    completedAt?: number;
    status: 'pending' | 'approved' | 'denied' | 'canceled';
    reason?: string;
    mode?: string;
    allowedTools?: string[];
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
};

/** Content of a `tool-result` message part (mirrors typesRaw NormalizedMessage). */
type ToolResultContent = {
    type: 'tool-result';
    tool_use_id: string;
    content: any;
    is_error: boolean;
    uuid: string;
    parentUUID: string | null;
    permissions?: {
        date: number;
        result: 'approved' | 'denied';
        mode?: string;
        allowedTools?: string[];
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
    };
};

export type ReducerState = {
    toolIdToMessageId: Map<string, string>; // toolId/permissionId -> messageId (since they're the same now)
    sidechainToolIdToMessageId: Map<string, string>; // toolId -> sidechain messageId (for dual tracking)
    // tool-result whose tool-call message hasn't been seen yet. Backward backfill
    // paginates newest→oldest, so a result page can arrive before its (older)
    // tool-call page. Instead of dropping the orphan result (→ tool stuck
    // "running" forever), stash it here keyed by tool_use_id and apply it when
    // the tool-call finally arrives in Phase 2 — decoupled from page arrival order.
    pendingToolResults: Map<string, { result: ToolResultContent; createdAt: number }>;
    permissions: Map<string, StoredPermission>; // Store permission details by ID for quick lookup
    localIds: Map<string, string>;
    messageIds: Map<string, string>; // originalId -> internalId
    messages: Map<string, ReducerMessage>;
    sidechains: Map<string, ReducerMessage[]>;
    tracerState: TracerState; // Tracer state for sidechain processing
    nextSortOrder: number; // Monotonic counter feeding ReducerMessage.sortOrder
    /** Durable turn boundaries used to place queued input at first consumption. */
    turnEnds: TurnEndBoundary[];
    latestTodos?: {
        todos: TodoItem[];
        timestamp: number;
    };
    latestUsage?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
        /** 真实生效的模型 id（B-135）——上下文窗口分母按它选，不是按我们请求的那个 */
        model?: string;
        timestamp: number;
    };
};

export function createReducer(): ReducerState {
    return {
        toolIdToMessageId: new Map(),
        sidechainToolIdToMessageId: new Map(),
        pendingToolResults: new Map(),
        permissions: new Map(),
        messages: new Map(),
        localIds: new Map(),
        messageIds: new Map(),
        sidechains: new Map(),
        tracerState: createTracer(),
        nextSortOrder: 0,
        turnEnds: [],
    }
};

const ENABLE_LOGGING = false;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeToolInputs(existingInput: unknown, nextInput: unknown): unknown {
    if (isRecord(existingInput) && isRecord(nextInput)) {
        return { ...nextInput, ...existingInput };
    }
    return nextInput ?? existingInput;
}

function getSidechainOwner(state: ReducerState, sidechainId: string): ReducerMessage | null {
    const ownerMessageId = state.messageIds.get(sidechainId);
    if (ownerMessageId) {
        const owner = state.messages.get(ownerMessageId);
        if (owner?.tool) {
            return owner;
        }
    }

    for (const message of state.messages.values()) {
        if (message.realID === sidechainId && message.tool) {
            return message;
        }
    }

    return null;
}

function getVisibleSidechainPrompt(owner: ReducerMessage | null): string | null {
    const prompt = owner?.tool?.input?.prompt;
    if (typeof prompt !== 'string') {
        return null;
    }
    const normalized = prompt.trim();
    return normalized.length > 0 ? normalized : null;
}

function isDuplicateSidechainPrompt(
    existingSidechain: ReducerMessage[],
    ownerPrompt: string | null,
    text: string,
): boolean {
    if (existingSidechain.length > 0 || !ownerPrompt) {
        return false;
    }

    return text.trim() === ownerPrompt;
}

export type ReducerResult = {
    messages: Message[];
    todos?: TodoItem[];
    usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
        model?: string;
    };
    hasReadyEvent?: boolean;
};

function updateLatestTodos(state: ReducerState, value: unknown, timestamp: number) {
    const parsed = TodoItemsSchema.safeParse(value);
    if (!parsed.success) {
        return;
    }

    if (!state.latestTodos || timestamp > state.latestTodos.timestamp) {
        state.latestTodos = {
            todos: parsed.data,
            timestamp,
        };
    }
}

/**
 * Apply a tool-result onto its (running) tool message. Shared by Phase 3 (normal
 * result path) and Phase 2's orphan-result flush, so pairing is identical
 * regardless of whether the result or the tool-call was seen first.
 */
function applyToolResult(
    state: ReducerState,
    message: ReducerMessage,
    messageId: string,
    result: ToolResultContent,
    resultCreatedAt: number,
    changed: Set<string>,
): void {
    if (!message.tool) return;
    // Only a running tool accepts a result — a permission-denied/errored tool was
    // already finalized (in Phase 2) and must not be overwritten.
    if (message.tool.state !== 'running') return;

    message.tool.state = result.is_error ? 'error' : 'completed';
    message.tool.result = result.content;
    message.tool.completedAt = resultCreatedAt;

    if (result.permissions) {
        if (message.tool.permission) {
            const existingDecision = message.tool.permission.decision;
            message.tool.permission = {
                ...message.tool.permission,
                id: result.tool_use_id,
                status: result.permissions.result === 'approved' ? 'approved' : 'denied',
                date: result.permissions.date,
                mode: result.permissions.mode,
                allowedTools: result.permissions.allowedTools,
                decision: result.permissions.decision || existingDecision,
            };
        } else {
            message.tool.permission = {
                id: result.tool_use_id,
                status: result.permissions.result === 'approved' ? 'approved' : 'denied',
                date: result.permissions.date,
                mode: result.permissions.mode,
                allowedTools: result.permissions.allowedTools,
                decision: result.permissions.decision,
            };
        }
    }

    if (message.tool.name === 'TodoWrite' && !result.is_error) {
        updateLatestTodos(state, message.tool.result?.newTodos, resultCreatedAt);
    }

    changed.add(messageId);
}

export function reducer(state: ReducerState, messages: NormalizedMessage[], agentState?: AgentState | null): ReducerResult {
    if (ENABLE_LOGGING) {
        console.log(`[REDUCER] Called with ${messages.length} messages, agentState: ${agentState ? 'YES' : 'NO'}`);
        if (agentState?.requests) {
            console.log(`[REDUCER] AgentState has ${Object.keys(agentState.requests).length} pending requests`);
        }
        if (agentState?.completedRequests) {
            console.log(`[REDUCER] AgentState has ${Object.keys(agentState.completedRequests).length} completed requests`);
        }
    }

    let newMessages: Message[] = [];
    let changed: Set<string> = new Set();
    let hasReadyEvent = false;
    // Turn-end metadata (cost/duration/turns/usage) from ready events, applied
    // after Phase 1 so it lands on the turn's final agent-text message.
    const pendingTurnMeta: { createdAt: number; turnMeta: NonNullable<Extract<AgentEvent, { type: 'ready' }>['turnMeta']> }[] = [];

    // First, trace all messages to identify sidechains
    const tracedMessages = traceMessages(state.tracerState, messages);

    // Separate sidechain and non-sidechain messages
    let nonSidechainMessages = tracedMessages.filter(msg => !msg.sidechainId);
    const sidechainMessages = tracedMessages.filter(msg => msg.sidechainId);

    //
    // Phase 0.5: Message-to-Event Conversion
    // Convert certain messages to events before normal processing
    //

    if (ENABLE_LOGGING) {
        console.log(`[REDUCER] Phase 0.5: Message-to-Event Conversion`);
    }

    const messagesToProcess: NormalizedMessage[] = [];
    const convertedEvents: { message: NormalizedMessage, event: AgentEvent }[] = [];

    for (const msg of nonSidechainMessages) {
        // Check if we've already processed this message
        if (msg.role === 'user' && msg.localId && state.localIds.has(msg.localId)) {
            continue;
        }
        if (state.messageIds.has(msg.id)) {
            continue;
        }

        // Filter out ready events completely - they should not create any message
        if (msg.role === 'event' && msg.content.type === 'ready') {
            // Mark as processed to prevent duplication but don't add to messages
            state.messageIds.set(msg.id, msg.id);
            hasReadyEvent = true;
            if (msg.content.status === 'failed') {
                convertedEvents.push({
                    message: msg,
                    event: {
                        type: 'message',
                        message: msg.content.error?.trim() || 'Claude turn failed',
                    },
                });
            }
            state.turnEnds.push({ createdAt: msg.createdAt, seq: msg.seq });
            // A ready event carrying turn metadata marks turn completion. Defer
            // stamping until after Phase 1 (which creates the agent-text
            // messages) so bulk history loads — where all events are handled
            // before any text is created — still associate correctly. Resolve
            // by createdAt against the turn's final agent-text message.
            if (msg.content.turnMeta) {
                pendingTurnMeta.push({ createdAt: msg.createdAt, turnMeta: msg.content.turnMeta });
            }
            continue;
        }

        // Session protocol turn-start markers are lifecycle-only and should stay invisible.
        if (msg.role === 'event' && msg.content.type === 'message' && msg.content.message === 'Turn started') {
            state.messageIds.set(msg.id, msg.id);
            continue;
        }

        // Handle context reset events - reset state and let the message be shown
        if (msg.role === 'event' && msg.content.type === 'message' && msg.content.message === 'Context was reset') {
            // Reset todos to empty array and reset usage to zero
            state.latestTodos = {
                todos: [],
                timestamp: msg.createdAt  // Use message timestamp, not current time
            };
            state.latestUsage = {
                inputTokens: 0,
                outputTokens: 0,
                cacheCreation: 0,
                cacheRead: 0,
                contextSize: 0,
                // clear/compact 只清用量，不清模型——模型没变，清了分母会退回默认值（B-135）
                model: state.latestUsage?.model,
                timestamp: msg.createdAt  // Use message timestamp to avoid blocking older usage data
            };
            // Don't continue - let the event be processed normally to create a message
        }

        // Handle compaction completed events - reset context but keep todos
        if (msg.role === 'event' && msg.content.type === 'message' && msg.content.message === 'Compaction completed') {
            // Reset usage/context to zero but keep todos unchanged
            state.latestUsage = {
                inputTokens: 0,
                outputTokens: 0,
                cacheCreation: 0,
                cacheRead: 0,
                contextSize: 0,
                // clear/compact 只清用量，不清模型——模型没变，清了分母会退回默认值（B-135）
                model: state.latestUsage?.model,
                timestamp: msg.createdAt  // Use message timestamp to avoid blocking older usage data
            };
            // Don't continue - let the event be processed normally to create a message
        }

        // Try to parse message as event
        const event = parseMessageAsEvent(msg);
        if (event) {
            if (ENABLE_LOGGING) {
                console.log(`[REDUCER] Converting message ${msg.id} to event:`, event);
            }
            convertedEvents.push({ message: msg, event });
            // Mark as processed to prevent duplication
            state.messageIds.set(msg.id, msg.id);
            if (msg.role === 'user' && msg.localId) {
                state.localIds.set(msg.localId, msg.id);
            }
        } else {
            messagesToProcess.push(msg);
        }
    }

    // Process converted events immediately
    for (const { message, event } of convertedEvents) {
        const mid = allocateId();
        state.messages.set(mid, {
            id: mid,
            realID: message.id,
            role: 'agent',
            createdAt: message.createdAt,
            seq: message.seq,
            sortOrder: state.nextSortOrder++,
            event: event,
            tool: null,
            text: null,
            meta: message.meta,
        });
        changed.add(mid);
    }

    // Update nonSidechainMessages to only include messages that weren't converted
    nonSidechainMessages = messagesToProcess;

    // Build a set of incoming tool IDs for quick lookup
    const incomingToolIds = new Set<string>();
    for (let msg of nonSidechainMessages) {
        if (msg.role === 'agent') {
            for (let c of msg.content) {
                if (c.type === 'tool-call') {
                    incomingToolIds.add(c.id);
                }
            }
        }
    }

    //
    // Phase 0: Process AgentState permissions
    //

    if (ENABLE_LOGGING) {
        console.log(`[REDUCER] Phase 0: Processing AgentState`);
    }
    if (agentState) {
        // Process pending permission requests
        if (agentState.requests) {
            for (const [permId, request] of Object.entries(agentState.requests)) {
                // Skip if this permission is also in completedRequests (completed takes precedence)
                if (agentState.completedRequests && agentState.completedRequests[permId]) {
                    continue;
                }

                // Check if we already have a message for this permission ID
                const existingMessageId = state.toolIdToMessageId.get(permId);
                if (existingMessageId) {
                    // Update existing tool message with permission info
                    const message = state.messages.get(existingMessageId);
                    if (message?.tool && !message.tool.permission) {
                        if (ENABLE_LOGGING) {
                            console.log(`[REDUCER] Updating existing tool ${permId} with permission`);
                        }
                        message.tool.permission = {
                            id: permId,
                            status: 'pending'
                        };
                        changed.add(existingMessageId);
                    }
                } else {
                    if (ENABLE_LOGGING) {
                        console.log(`[REDUCER] Creating new message for permission ${permId}`);
                    }

                    // Create a new tool message for the permission request
                    let mid = allocateId();
                    let toolCall: ToolCall = {
                        name: request.tool,
                        state: 'running' as const,
                        input: request.arguments,
                        createdAt: request.createdAt || Date.now(),
                        startedAt: null,
                        completedAt: null,
                        description: null,
                        result: undefined,
                        permission: {
                            id: permId,
                            status: 'pending'
                        }
                    };

                    state.messages.set(mid, {
                        id: mid,
                        realID: null,
                        role: 'agent',
                        createdAt: request.createdAt || Date.now(),
                        sortOrder: state.nextSortOrder++,
                        text: null,
                        tool: toolCall,
                        event: null,
                    });

                    // Store by permission ID (which will match tool ID)
                    state.toolIdToMessageId.set(permId, mid);

                    changed.add(mid);
                }

                // Store permission details for quick lookup
                state.permissions.set(permId, {
                    tool: request.tool,
                    arguments: request.arguments,
                    createdAt: request.createdAt || Date.now(),
                    status: 'pending'
                });
            }
        }

        // Process completed permission requests
        if (agentState.completedRequests) {
            for (const [permId, completed] of Object.entries(agentState.completedRequests)) {
                // Check if we have a message for this permission ID
                const messageId = state.toolIdToMessageId.get(permId);
                if (messageId) {
                    const message = state.messages.get(messageId);
                    if (message?.tool) {
                        // Skip if tool has already started actual execution with approval
                        if (message.tool.startedAt && message.tool.permission?.status === 'approved') {
                            continue;
                        }

                        // Skip if permission already has date (came from tool result - preferred over agentState)
                        if (message.tool.permission?.date) {
                            continue;
                        }

                        // Check if we need to update ANY field
                        const needsUpdate = 
                            message.tool.permission?.status !== completed.status ||
                            message.tool.permission?.reason !== completed.reason ||
                            message.tool.permission?.mode !== completed.mode ||
                            message.tool.permission?.allowedTools !== completed.allowedTools ||
                            message.tool.permission?.decision !== completed.decision;

                        if (!needsUpdate) {
                            continue;
                        }

                        let hasChanged = false;

                        // Update permission status
                        if (!message.tool.permission) {
                            message.tool.permission = {
                                id: permId,
                                status: completed.status,
                                mode: completed.mode || undefined,
                                allowedTools: completed.allowedTools || undefined,
                                decision: completed.decision || undefined,
                                reason: completed.reason || undefined
                            };
                            hasChanged = true;
                        } else {
                            // Update all fields
                            message.tool.permission.status = completed.status;
                            message.tool.permission.mode = completed.mode || undefined;
                            message.tool.permission.allowedTools = completed.allowedTools || undefined;
                            message.tool.permission.decision = completed.decision || undefined;
                            if (completed.reason) {
                                message.tool.permission.reason = completed.reason;
                            }
                            hasChanged = true;
                        }

                        // Update tool state based on permission status
                        if (completed.status === 'approved') {
                            if (message.tool.state !== 'completed' && message.tool.state !== 'error' && message.tool.state !== 'running') {
                                message.tool.state = 'running';
                                hasChanged = true;
                            }
                        } else {
                            // denied or canceled
                            if (message.tool.state !== 'error' && message.tool.state !== 'completed') {
                                message.tool.state = 'error';
                                message.tool.completedAt = completed.completedAt || Date.now();
                                if (!message.tool.result && completed.reason) {
                                    message.tool.result = { error: completed.reason };
                                }
                                hasChanged = true;
                            }
                        }

                        // Update stored permission
                        state.permissions.set(permId, {
                            tool: completed.tool,
                            arguments: completed.arguments,
                            createdAt: completed.createdAt || Date.now(),
                            completedAt: completed.completedAt || undefined,
                            status: completed.status,
                            reason: completed.reason || undefined,
                            mode: completed.mode || undefined,
                            allowedTools: completed.allowedTools || undefined,
                            decision: completed.decision || undefined
                        });

                        if (hasChanged) {
                            changed.add(messageId);
                        }
                    }
                } else {
                    // No existing message - check if tool ID is in incoming messages
                    if (incomingToolIds.has(permId)) {
                        if (ENABLE_LOGGING) {
                            console.log(`[REDUCER] Storing permission ${permId} for incoming tool`);
                        }
                        // Store permission for when tool arrives in Phase 2
                        state.permissions.set(permId, {
                            tool: completed.tool,
                            arguments: completed.arguments,
                            createdAt: completed.createdAt || Date.now(),
                            completedAt: completed.completedAt || undefined,
                            status: completed.status,
                            reason: completed.reason || undefined
                        });
                        continue;
                    }

                    // Skip if already processed as pending
                    if (agentState.requests && agentState.requests[permId]) {
                        continue;
                    }

                    // Create a new message for completed permission without tool
                    let mid = allocateId();
                    let toolCall: ToolCall = {
                        name: completed.tool,
                        state: completed.status === 'approved' ? 'completed' : 'error',
                        input: completed.arguments,
                        createdAt: completed.createdAt || Date.now(),
                        startedAt: null,
                        completedAt: completed.completedAt || Date.now(),
                        description: null,
                        result: completed.status === 'approved'
                            ? 'Approved'
                            : (completed.reason ? { error: completed.reason } : undefined),
                        permission: {
                            id: permId,
                            status: completed.status,
                            reason: completed.reason || undefined,
                            mode: completed.mode || undefined,
                            allowedTools: completed.allowedTools || undefined,
                            decision: completed.decision || undefined
                        }
                    };

                    state.messages.set(mid, {
                        id: mid,
                        realID: null,
                        role: 'agent',
                        createdAt: completed.createdAt || Date.now(),
                        sortOrder: state.nextSortOrder++,
                        text: null,
                        tool: toolCall,
                        event: null,
                    });

                    state.toolIdToMessageId.set(permId, mid);

                    // Store permission details
                    state.permissions.set(permId, {
                        tool: completed.tool,
                        arguments: completed.arguments,
                        createdAt: completed.createdAt || Date.now(),
                        completedAt: completed.completedAt || undefined,
                        status: completed.status,
                        reason: completed.reason || undefined,
                        mode: completed.mode || undefined,
                        allowedTools: completed.allowedTools || undefined,
                        decision: completed.decision || undefined
                    });

                    changed.add(mid);
                }
            }
        }
    }

    //
    // Phase 1: Process non-sidechain user messages and text messages
    // 

    for (let msg of nonSidechainMessages) {
        if (msg.role === 'user') {
            // Check if we've seen this localId before
            if (msg.localId && state.localIds.has(msg.localId)) {
                continue;
            }
            // Check if we've seen this message ID before
            if (state.messageIds.has(msg.id)) {
                continue;
            }

            // Create a new message
            let mid = allocateId();
            state.messages.set(mid, {
                id: mid,
                realID: msg.id,
                role: 'user',
                localId: msg.localId,
                createdAt: msg.createdAt,
                seq: msg.seq,
                sortOrder: state.nextSortOrder++,
                text: msg.content.text,
                tool: null,
                event: null,
                meta: msg.meta,
                claudeUuid: msg.claudeUuid,
                codexItemId: msg.codexItemId,
            });

            // Track both localId and messageId
            if (msg.localId) {
                state.localIds.set(msg.localId, mid);
            }
            state.messageIds.set(msg.id, mid);

            changed.add(mid);
        } else if (msg.role === 'agent') {
            // Check if we've seen this agent message before
            if (state.messageIds.has(msg.id)) {
                continue;
            }

            // Mark this message as seen
            state.messageIds.set(msg.id, msg.id);

            // Process usage data if present
            if (msg.usage) {
                processUsageData(state, msg.usage, msg.createdAt, msg.model);
            }

            // Per-message usage snapshot (camelCase) for per-turn display.
            const msgUsage: TurnUsage | undefined = msg.usage ? {
                inputTokens: msg.usage.input_tokens,
                outputTokens: msg.usage.output_tokens,
                ...(typeof msg.usage.cache_creation_input_tokens === 'number' ? { cacheCreation: msg.usage.cache_creation_input_tokens } : {}),
                ...(typeof msg.usage.cache_read_input_tokens === 'number' ? { cacheRead: msg.usage.cache_read_input_tokens } : {}),
            } : undefined;

            // Process text and thinking content (tool calls handled in Phase 2)
            for (let c of msg.content) {
                if (c.type === 'text' || c.type === 'thinking') {
                    let mid = allocateId();
                    const isThinking = c.type === 'thinking';
                    state.messages.set(mid, {
                        id: mid,
                        realID: msg.id,
                        role: 'agent',
                        createdAt: msg.createdAt,
                        seq: msg.seq,
                        sortOrder: state.nextSortOrder++,
                        text: isThinking ? `*${c.thinking}*` : c.text,
                        isThinking,
                        tool: null,
                        event: null,
                        meta: msg.meta,
                        usage: msgUsage,
                    });
                    changed.add(mid);
                }
            }
        }
    }

    //
    // Phase 2: Process non-sidechain tool calls
    //

    if (ENABLE_LOGGING) {
        console.log(`[REDUCER] Phase 2: Processing tool calls`);
    }
    for (let msg of nonSidechainMessages) {
        if (msg.role === 'agent') {
            for (let c of msg.content) {
                if (c.type === 'tool-call') {
                    // Direct lookup by tool ID (since permission ID = tool ID now)
                    const existingMessageId = state.toolIdToMessageId.get(c.id);

                    if (existingMessageId) {
                        if (ENABLE_LOGGING) {
                            console.log(`[REDUCER] Found existing message for tool ${c.id}`);
                        }
                        // Update existing message with tool execution details
                        const message = state.messages.get(existingMessageId);
                        if (message?.tool) {
                            message.realID = msg.id;
                            // Permission-synthesized messages have no seq; adopt
                            // the real tool-call's server seq so the message
                            // sorts at the point the tool actually ran.
                            if (message.seq === undefined || message.seq === null) {
                                message.seq = msg.seq;
                            }
                            message.tool.input = mergeToolInputs(message.tool.input, c.input);
                            message.tool.description = c.description;
                            message.tool.startedAt = msg.createdAt;
                            // If permission was approved and shown as completed (no tool), now it's running
                            if (message.tool.permission?.status === 'approved' && message.tool.state === 'completed') {
                                message.tool.state = 'running';
                                message.tool.completedAt = null;
                                message.tool.result = undefined;
                            }
                            changed.add(existingMessageId);

                        }
                    } else {
                        if (ENABLE_LOGGING) {
                            console.log(`[REDUCER] Creating new message for tool ${c.id}`);
                        }
                        // Check if there's a stored permission for this tool
                        const permission = state.permissions.get(c.id);

                        let toolCall: ToolCall = {
                            name: c.name,
                            state: 'running' as const,
                            input: permission ? mergeToolInputs(permission.arguments, c.input) : c.input,
                            createdAt: permission ? permission.createdAt : msg.createdAt,  // Use permission timestamp if available
                            startedAt: msg.createdAt,
                            completedAt: null,
                            description: c.description,
                            result: undefined,
                        };

                        // Add permission info if found
                        if (permission) {
                            if (ENABLE_LOGGING) {
                                console.log(`[REDUCER] Found stored permission for tool ${c.id}`);
                            }
                            toolCall.permission = {
                                id: c.id,
                                status: permission.status,
                                reason: permission.reason,
                                mode: permission.mode,
                                allowedTools: permission.allowedTools,
                                decision: permission.decision
                            };

                            // Update state based on permission status
                            if (permission.status !== 'approved') {
                                toolCall.state = 'error';
                                toolCall.completedAt = permission.completedAt || msg.createdAt;
                                if (permission.reason) {
                                    toolCall.result = { error: permission.reason };
                                }
                            }
                        }

                        let mid = allocateId();
                        state.messages.set(mid, {
                            id: mid,
                            realID: msg.id,
                            role: 'agent',
                            createdAt: msg.createdAt,
                            seq: msg.seq,
                            sortOrder: state.nextSortOrder++,
                            text: null,
                            tool: toolCall,
                            event: null,
                            meta: msg.meta,
                        });

                        state.toolIdToMessageId.set(c.id, mid);
                        changed.add(mid);

                    }

                    // Flush a tool-result that arrived before this tool-call
                    // (backward backfill delivers result pages before older call
                    // pages). The tool message now exists, so apply the stashed
                    // result — otherwise the tool would stay "running" forever.
                    const pendingResult = state.pendingToolResults.get(c.id);
                    if (pendingResult) {
                        const mid2 = state.toolIdToMessageId.get(c.id);
                        const m2 = mid2 ? state.messages.get(mid2) : undefined;
                        if (m2 && mid2) {
                            applyToolResult(state, m2, mid2, pendingResult.result, pendingResult.createdAt, changed);
                        }
                        state.pendingToolResults.delete(c.id);
                    }
                }
            }
        }
    }

    //
    // Phase 3: Process non-sidechain tool results
    //

    for (let msg of nonSidechainMessages) {
        if (msg.role === 'agent') {
            for (let c of msg.content) {
                if (c.type === 'tool-result') {
                    // Find the message containing this tool.
                    const messageId = state.toolIdToMessageId.get(c.tool_use_id);
                    if (!messageId) {
                        // Orphan result: the tool-call message hasn't been seen
                        // yet (backward backfill delivers the result page before
                        // the older tool-call page). Stash it — Phase 2 applies it
                        // when the tool-call arrives (this or a later reducer run).
                        state.pendingToolResults.set(c.tool_use_id, { result: c, createdAt: msg.createdAt });
                        continue;
                    }

                    const message = state.messages.get(messageId);
                    if (!message || !message.tool) {
                        continue;
                    }

                    applyToolResult(state, message, messageId, c, msg.createdAt, changed);
                }
            }
        }
    }

    //
    // Phase 4: Process sidechains and store them in state
    //

    // For each sidechain message, store it in the state and mark the Task as changed
    for (const msg of sidechainMessages) {
        if (!msg.sidechainId) continue;

        // Skip if we already processed this message
        if (state.messageIds.has(msg.id)) continue;

        // Mark as processed
        state.messageIds.set(msg.id, msg.id);

        // Get or create the sidechain array for this Task
        const existingSidechain = state.sidechains.get(msg.sidechainId) || [];
        const owner = getSidechainOwner(state, msg.sidechainId);
        const ownerPrompt = getVisibleSidechainPrompt(owner);

        // Process and add new sidechain messages
        if (msg.role === 'agent' && msg.content[0]?.type === 'sidechain') {
            // This is the sidechain root - create a user message
            if (isDuplicateSidechainPrompt(existingSidechain, ownerPrompt, msg.content[0].prompt)) {
                state.sidechains.set(msg.sidechainId, existingSidechain);
                continue;
            }
            let mid = allocateId();
            let userMsg: ReducerMessage = {
                id: mid,
                realID: msg.id,
                role: 'user',
                createdAt: msg.createdAt,
                seq: msg.seq,
                sortOrder: state.nextSortOrder++,
                text: msg.content[0].prompt,
                tool: null,
                event: null,
                meta: msg.meta,
            };
            state.messages.set(mid, userMsg);
            existingSidechain.push(userMsg);
        } else if (msg.role === 'agent') {
            // Process agent content in sidechain
            for (let c of msg.content) {
                if (c.type === 'text' || c.type === 'thinking') {
                    const text = c.type === 'thinking' ? c.thinking : c.text;
                    if (c.type === 'text' && isDuplicateSidechainPrompt(existingSidechain, ownerPrompt, text)) {
                        continue;
                    }
                    let mid = allocateId();
                    const isThinking = c.type === 'thinking';
                    let textMsg: ReducerMessage = {
                        id: mid,
                        realID: msg.id,
                        role: 'agent',
                        createdAt: msg.createdAt,
                        seq: msg.seq,
                        sortOrder: state.nextSortOrder++,
                        text: isThinking ? `*${c.thinking}*` : c.text,
                        isThinking,
                        tool: null,
                        event: null,
                        meta: msg.meta,
                    };
                    state.messages.set(mid, textMsg);
                    existingSidechain.push(textMsg);
                } else if (c.type === 'tool-call') {
                    // Check if there's already a permission message for this tool
                    const existingPermissionMessageId = state.toolIdToMessageId.get(c.id);

                    let mid = allocateId();
                    let toolCall: ToolCall = {
                        name: c.name,
                        state: 'running' as const,
                        input: c.input,
                        createdAt: msg.createdAt,
                        startedAt: null,
                        completedAt: null,
                        description: c.description,
                        result: undefined
                    };

                    // If there's a permission message, copy its permission info
                    if (existingPermissionMessageId) {
                        const permissionMessage = state.messages.get(existingPermissionMessageId);
                        if (permissionMessage?.tool?.permission) {
                            toolCall.permission = { ...permissionMessage.tool.permission };
                            // Update the permission message to show it's running
                            if (permissionMessage.tool.state !== 'completed' && permissionMessage.tool.state !== 'error') {
                                permissionMessage.tool.state = 'running';
                                permissionMessage.tool.startedAt = msg.createdAt;
                                permissionMessage.tool.description = c.description;
                                changed.add(existingPermissionMessageId);
                            }
                        }
                    }

                    let toolMsg: ReducerMessage = {
                        id: mid,
                        realID: msg.id,
                        role: 'agent',
                        createdAt: msg.createdAt,
                        seq: msg.seq,
                        sortOrder: state.nextSortOrder++,
                        text: null,
                        tool: toolCall,
                        event: null,
                        meta: msg.meta,
                    };
                    state.messages.set(mid, toolMsg);
                    existingSidechain.push(toolMsg);

                    // Map sidechain tool separately to avoid overwriting permission mapping
                    state.sidechainToolIdToMessageId.set(c.id, mid);
                } else if (c.type === 'tool-result') {
                    // Process tool result in sidechain - update BOTH messages

                    // Update the sidechain tool message
                    let sidechainMessageId = state.sidechainToolIdToMessageId.get(c.tool_use_id);
                    if (sidechainMessageId) {
                        let sidechainMessage = state.messages.get(sidechainMessageId);
                        if (sidechainMessage && sidechainMessage.tool && sidechainMessage.tool.state === 'running') {
                            sidechainMessage.tool.state = c.is_error ? 'error' : 'completed';
                            sidechainMessage.tool.result = c.content;
                            sidechainMessage.tool.completedAt = msg.createdAt;
                            
                            // Update permission data if provided by backend
                            if (c.permissions) {
                                // Merge with existing permission to preserve decision field from agentState
                                if (sidechainMessage.tool.permission) {
                                    const existingDecision = sidechainMessage.tool.permission.decision;
                                    sidechainMessage.tool.permission = {
                                        ...sidechainMessage.tool.permission,
                                        id: c.tool_use_id,
                                        status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                                        date: c.permissions.date,
                                        mode: c.permissions.mode,
                                        allowedTools: c.permissions.allowedTools,
                                        decision: c.permissions.decision || existingDecision
                                    };
                                } else {
                                    sidechainMessage.tool.permission = {
                                        id: c.tool_use_id,
                                        status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                                        date: c.permissions.date,
                                        mode: c.permissions.mode,
                                        allowedTools: c.permissions.allowedTools,
                                        decision: c.permissions.decision
                                    };
                                }
                            }
                        }
                    }

                    // Also update the main permission message if it exists
                    let permissionMessageId = state.toolIdToMessageId.get(c.tool_use_id);
                    if (permissionMessageId) {
                        let permissionMessage = state.messages.get(permissionMessageId);
                        if (permissionMessage && permissionMessage.tool && permissionMessage.tool.state === 'running') {
                            permissionMessage.tool.state = c.is_error ? 'error' : 'completed';
                            permissionMessage.tool.result = c.content;
                            permissionMessage.tool.completedAt = msg.createdAt;
                            
                            // Update permission data if provided by backend
                            if (c.permissions) {
                                // Merge with existing permission to preserve decision field from agentState
                                if (permissionMessage.tool.permission) {
                                    const existingDecision = permissionMessage.tool.permission.decision;
                                    permissionMessage.tool.permission = {
                                        ...permissionMessage.tool.permission,
                                        id: c.tool_use_id,
                                        status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                                        date: c.permissions.date,
                                        mode: c.permissions.mode,
                                        allowedTools: c.permissions.allowedTools,
                                        decision: c.permissions.decision || existingDecision
                                    };
                                } else {
                                    permissionMessage.tool.permission = {
                                        id: c.tool_use_id,
                                        status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                                        date: c.permissions.date,
                                        mode: c.permissions.mode,
                                        allowedTools: c.permissions.allowedTools,
                                        decision: c.permissions.decision
                                    };
                                }
                            }
                            
                            changed.add(permissionMessageId);
                        }
                    }
                }
            }
        }

        // Update the sidechain in state
        state.sidechains.set(msg.sidechainId, existingSidechain);

        // Find the Task tool message that owns this sidechain and mark it as changed
        // msg.sidechainId is the realID of the Task message
        for (const [internalId, message] of state.messages) {
            if (message.realID === msg.sidechainId && message.tool) {
                changed.add(internalId);
                break;
            }
        }
    }

    //
    // Phase 5: Process mode-switch messages
    //

    for (let msg of nonSidechainMessages) {
        if (msg.role === 'event') {
            let mid = allocateId();
            state.messages.set(mid, {
                id: mid,
                realID: msg.id,
                role: 'agent',
                createdAt: msg.createdAt,
                seq: msg.seq,
                sortOrder: state.nextSortOrder++,
                event: msg.content,
                tool: null,
                text: null,
                meta: msg.meta,
            });
            changed.add(mid);
        }
    }

    //
    // Phase 6: Apply per-turn result metadata (cost / duration / turns / usage)
    //
    // A ready event marks turn completion. Associate its metadata with the
    // turn's final agent-text message: the non-thinking agent text with the
    // greatest createdAt at or before the turn-end time. Resolving by
    // createdAt (rather than processing order) is robust to bulk history
    // loads where all ready events are seen before any text is created.
    //
    for (const entry of pendingTurnMeta) {
        let target: ReducerMessage | null = null;
        for (const message of state.messages.values()) {
            if (message.role !== 'agent' || message.isThinking || message.text === null || message.tool !== null || message.event !== null) {
                continue;
            }
            if (message.text.trim().length === 0) {
                continue;
            }
            if (message.createdAt > entry.createdAt) {
                continue;
            }
            if (!target || message.createdAt > target.createdAt) {
                target = message;
            }
        }
        if (target) {
            const { turnMeta } = entry;
            if (typeof turnMeta.costUsd === 'number') target.costUsd = turnMeta.costUsd;
            if (typeof turnMeta.totalDurationMs === 'number') target.totalDurationMs = turnMeta.totalDurationMs;
            if (typeof turnMeta.numTurns === 'number') target.numTurns = turnMeta.numTurns;
            if (turnMeta.usage) target.usage = turnMeta.usage;
            changed.add(target.id);
        }
    }

    // Reconcile every marked user/file input against the earliest known
    // turn-end. History pages arrive newest-first, so a later backfill may
    // reveal an earlier boundary and must be allowed to reposition the item.
    for (const message of state.messages.values()) {
        const queuedAt = message.meta?.queuedAt;
        const isInputItem = message.role === 'user' || message.tool?.name === 'file';
        if (!isInputItem || typeof queuedAt !== 'number') continue;
        const boundary = firstTurnEndForQueuedInput(
            { queuedAt, seq: message.seq },
            state.turnEnds,
        );
        const nextInputState = boundary ? undefined : 'queued';
        const nextDisplaySeq = boundary?.seq;
        const nextDisplayAt = boundary?.createdAt;
        if (
            message.inputState !== nextInputState
            || message.displaySeq !== nextDisplaySeq
            || message.displayAt !== nextDisplayAt
        ) {
            message.inputState = nextInputState;
            message.displaySeq = nextDisplaySeq;
            message.displayAt = nextDisplayAt;
            changed.add(message.id);
        }
    }

    //
    // Collect changed messages (only root-level messages)
    //

    for (let id of changed) {
        let existing = state.messages.get(id);
        if (!existing) continue;

        let message = convertReducerMessageToMessage(existing, state);
        if (message) {
            newMessages.push(message);
        }
    }

    //
    // Debug changes
    //

    if (ENABLE_LOGGING) {
        console.log(JSON.stringify(messages, null, 2));
        console.log(`[REDUCER] Changed messages: ${changed.size}`);
    }

    return {
        messages: newMessages,
        todos: state.latestTodos?.todos,
        usage: state.latestUsage ? {
            inputTokens: state.latestUsage.inputTokens,
            outputTokens: state.latestUsage.outputTokens,
            cacheCreation: state.latestUsage.cacheCreation,
            cacheRead: state.latestUsage.cacheRead,
            contextSize: state.latestUsage.contextSize,
            model: state.latestUsage.model
        } : undefined,
        hasReadyEvent: hasReadyEvent || undefined
    };
}

//
// Helpers
//

function allocateId() {
    return Math.random().toString(36).substring(2, 15);
}

function processUsageData(state: ReducerState, usage: UsageData, timestamp: number, model?: string) {
    // Only update if this is newer than the current latest usage
    if (!state.latestUsage || timestamp > state.latestUsage.timestamp) {
        state.latestUsage = {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheCreation: usage.cache_creation_input_tokens || 0,
            cacheRead: usage.cache_read_input_tokens || 0,
            contextSize: (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0) + usage.input_tokens,
            // 模型缺失时保留上一次已知的：单条消息漏了不该让分母退回默认值
            model: model ?? state.latestUsage?.model,
            timestamp: timestamp
        };
    }
}


function convertReducerMessageToMessage(reducerMsg: ReducerMessage, state: ReducerState): Message | null {
    if (reducerMsg.role === 'user' && reducerMsg.text !== null) {
        return {
            id: reducerMsg.id,
            localId: reducerMsg.localId ?? null,
            createdAt: reducerMsg.createdAt,
            seq: reducerMsg.seq,
            sortOrder: reducerMsg.sortOrder,
            displaySeq: reducerMsg.displaySeq,
            displayAt: reducerMsg.displayAt,
            kind: 'user-text',
            text: reducerMsg.text,
            ...(reducerMsg.meta?.displayText && { displayText: reducerMsg.meta.displayText }),
            ...(reducerMsg.inputState === 'queued' ? { inputState: 'queued' as const } : {}),
            ...(reducerMsg.claudeUuid && { claudeUuid: reducerMsg.claudeUuid }),
            ...(reducerMsg.codexItemId && { codexItemId: reducerMsg.codexItemId }),
            meta: reducerMsg.meta
        };
    } else if (reducerMsg.role === 'agent' && reducerMsg.text !== null) {
        return {
            id: reducerMsg.id,
            localId: null,
            createdAt: reducerMsg.createdAt,
            seq: reducerMsg.seq,
            sortOrder: reducerMsg.sortOrder,
            kind: 'agent-text',
            text: reducerMsg.text,
            ...(reducerMsg.isThinking && { isThinking: true }),
            ...(reducerMsg.usage && { usage: reducerMsg.usage }),
            ...(typeof reducerMsg.costUsd === 'number' && { costUsd: reducerMsg.costUsd }),
            ...(typeof reducerMsg.totalDurationMs === 'number' && { totalDurationMs: reducerMsg.totalDurationMs }),
            ...(typeof reducerMsg.numTurns === 'number' && { numTurns: reducerMsg.numTurns }),
            meta: reducerMsg.meta
        };
    } else if (reducerMsg.role === 'agent' && reducerMsg.tool !== null) {
        // Convert children recursively
        let childMessages: Message[] = [];
        let children = reducerMsg.realID ? state.sidechains.get(reducerMsg.realID) || [] : [];
        for (let child of children) {
            let childMessage = convertReducerMessageToMessage(child, state);
            if (childMessage) {
                childMessages.push(childMessage);
            }
        }

        return {
            id: reducerMsg.id,
            localId: null,
            createdAt: reducerMsg.createdAt,
            seq: reducerMsg.seq,
            sortOrder: reducerMsg.sortOrder,
            displaySeq: reducerMsg.displaySeq,
            displayAt: reducerMsg.displayAt,
            kind: 'tool-call',
            tool: { ...reducerMsg.tool },
            children: childMessages,
            meta: reducerMsg.meta,
            ...(reducerMsg.inputState === 'queued' ? { inputState: 'queued' as const } : {}),
        };
    } else if (reducerMsg.role === 'agent' && reducerMsg.event !== null) {
        return {
            id: reducerMsg.id,
            createdAt: reducerMsg.createdAt,
            seq: reducerMsg.seq,
            sortOrder: reducerMsg.sortOrder,
            kind: 'agent-event',
            event: reducerMsg.event,
            meta: reducerMsg.meta
        };
    }

    return null;
}
