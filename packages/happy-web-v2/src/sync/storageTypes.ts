import { z } from "zod";

//
// Agent states
//

export const MetadataSchema = z.object({
    models: z.array(z.object({
        code: z.string(),
        value: z.string(),
        description: z.string().nullish(),
    })).optional(),
    currentModelCode: z.string().optional(),
    defaultModelCode: z.string().optional(),
    operatingModes: z.array(z.object({
        code: z.string(),
        value: z.string(),
        description: z.string().nullish(),
    })).optional(),
    currentOperatingModeCode: z.string().optional(),
    thoughtLevels: z.array(z.object({
        code: z.string(),
        value: z.string(),
        description: z.string().nullish(),
    })).optional(),
    currentThoughtLevelCode: z.string().optional(),
    path: z.string(),
    host: z.string(),
    version: z.string().optional(),
    name: z.string().optional(),
    os: z.string().optional(),
    summary: z.object({
        text: z.string(),
        updatedAt: z.number()
    }).optional(),
    machineId: z.string().optional(),
    claudeSessionId: z.string().optional(), // Claude Code session ID
    codexThreadId: z.string().optional(), // Codex app-server thread ID
    tools: z.array(z.string()).optional(),
    slashCommands: z.array(z.string()).optional(),
    mcpServers: z.array(z.object({ name: z.string(), status: z.string() })).optional(),
    skills: z.array(z.string()).optional(),
    attachmentKinds: z.array(z.string()).optional(),
    /** The connected Claude runner can remove pending queue items by local id. */
    queueCancellation: z.boolean().optional(),
    /** Explicit daemon/CLI feature negotiation. Optional; never default it. */
    capabilities: z.array(z.string()).optional(),
    homeDir: z.string().optional(), // User's home directory on the machine
    happyHomeDir: z.string().optional(), // Happy configuration directory 
    startedFromDaemon: z.boolean().optional(),
    hostPid: z.number().optional(), // Process ID of the session
    startedBy: z.enum(['daemon', 'terminal']).optional(),
    flavor: z.string().nullish(), // Session flavor/variant identifier
    /**
     * B-105 terminal mirror: the web terminal (tmux vh-<terminalId>) this
     * shadow session mirrors. Set by the daemon on flavor 'terminal-mirror'
     * sessions only; optional — older sessions/daemons never write it.
     */
    terminalId: z.string().optional(),
    /**
     * Session presentation variant. 'assistant' marks the machine-side
     * meta-agent session that the /assistant voice view attaches to.
     * Optional string (not an enum) so future variants and newer clients
     * pass through unchanged — old clients ignore unknown values by design.
     */
    variant: z.string().optional(),
    sandbox: z.any().nullish(), // Sandbox config metadata from CLI (or null when disabled)
    dangerouslySkipPermissions: z.boolean().nullish(), // Claude --dangerously-skip-permissions mode (or null when unknown)
    lifecycleState: z.string().optional(),
    lifecycleStateSince: z.number().optional(),
    archivedBy: z.string().optional(),
    archiveReason: z.string().optional(),
    /**
     * Lineage for sessions created via the fork / duplicate flow.
     * `parentSessionId` is the Happy session this one was branched from.
     * `forkedFromMessageId` is the in-app message id used as the rewind
     * point (only set for "duplicate from message", not for plain fork).
     * Both ride inside encrypted metadata so the server stays oblivious.
     */
    parentSessionId: z.string().optional(),
    forkedFromMessageId: z.string().optional(),
    /**
     * User-assigned tags for this session (sidebar chips + `#tag` search).
     * Optional only — NO zod .default([]): clients that never touched tags
     * must not write an empty array into metadata. Edited via the rename
     * modal (sessionUpdateTitleTags); rides inside encrypted metadata.
     */
    tags: z.array(z.string()).optional(),
    /**
     * Task Board V2: latest daemon-side LLM analysis of this session
     * (happy-cli boardAnalyzer, opt-in). Absent until the machine-local
     * `boardLlm` toggle produces a first verdict. NO zod .default() —
     * optional only, so clients that never saw the field don't write one.
     */
    board: z.object({
        /** board task (KV vh.board-tasks.v1) this session was classified under */
        taskId: z.string().optional(),
        attention: z.enum(['none', 'review', 'blocked']).optional(),
        /** one-line progress note (Chinese) */
        progress: z.string().optional(),
        analyzedAt: z.number(),
    }).optional(),
    /**
     * When the USER marked this session done (task-board ✓ — an explicit
     * human action, never stamped by the agent finishing). The board's Done
     * column derives its session records from this. Optional only — NO zod
     * .default(), same discipline as `tags`/`board`.
     */
    completedAt: z.number().optional(),
});

export type Metadata = z.infer<typeof MetadataSchema>;

export const AgentStateSchema = z.object({
    controlledByUser: z.boolean().nullish(),
    requests: z.record(z.string(), z.object({
        tool: z.string(),
        arguments: z.any(),
        createdAt: z.number().nullish(),
        kind: z.enum(['tool', 'elicitation', 'user_dialog']).optional(),
        permissionSuggestions: z.array(z.object({
            type: z.string(),
            destination: z.string(),
        }).passthrough()).optional()
    })).nullish(),
    completedRequests: z.record(z.string(), z.object({
        tool: z.string(),
        arguments: z.any(),
        createdAt: z.number().nullish(),
        completedAt: z.number().nullish(),
        status: z.enum(['canceled', 'denied', 'approved']),
        reason: z.string().nullish(),
        mode: z.string().nullish(),
        allowedTools: z.array(z.string()).nullish(),
        decision: z.enum(['approved', 'approved_for_session', 'denied', 'abort']).nullish()
    })).nullish()
});

export type AgentState = z.infer<typeof AgentStateSchema>;

export const TodoItemSchema = z.object({
    content: z.string(),
    status: z.enum(['pending', 'in_progress', 'completed']),
    priority: z.enum(['high', 'medium', 'low']).optional(),
    id: z.string().optional(),
});

export const TodoItemsSchema = z.array(TodoItemSchema);

export type TodoItem = z.infer<typeof TodoItemSchema>;

export interface Session {
    id: string,
    seq: number,
    createdAt: number,
    updatedAt: number,
    active: boolean,
    activeAt: number,
    metadata: Metadata | null,
    metadataVersion: number,
    agentState: AgentState | null,
    agentStateVersion: number,
    thinking: boolean,
    thinkingAt: number,
    // Local (device-only, not synced) timestamp marking when `thinking` last
    // flipped false→true. Used by the session status bar to show "Thinking 12s".
    // Cleared (set to null/undefined) when thinking flips back to false. Set in
    // storage.applySessions so every code path that toggles thinking is covered.
    thinkingStartedAt?: number | null,
    presence: "online" | number, // "online" when active, timestamp when last seen
    todos?: TodoItem[];
    draft?: string | null; // Local draft message, not synced to server
    permissionMode?: string | null; // Pending local mode, rehydrated cross-device from latest sent message meta
    modelMode?: string | null; // Local model key, not synced to server
    effortLevel?: string | null; // Local effort level key, not synced to server
    // IMPORTANT: latestUsage is extracted from reducerState.latestUsage after message processing.
    // We store it directly on Session to ensure it's available immediately on load.
    // Do NOT store reducerState itself on Session - it's mutable and should only exist in SessionMessages.
    latestUsage?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
        /** 真实生效的模型 id（B-135）；旧客户端写的记录里没有这个字段，消费方必须容忍 undefined */
        model?: string;
        timestamp: number;
    } | null;
}

export interface DecryptedMessage {
    id: string,
    seq: number | null,
    localId: string | null,
    content: any,
    createdAt: number,
}

//
// Machine states
//

export const MachineMetadataSchema = z.object({
    host: z.string(),
    platform: z.string(),
    happyCliVersion: z.string(),
    happyHomeDir: z.string(), // Directory for Happy auth, settings, logs (usually .happy/ or .happy-dev/)
    homeDir: z.string(), // User's home directory (matches CLI field name)
    // Optional fields that may be added in future versions
    username: z.string().optional(),
    arch: z.string().optional(),
    displayName: z.string().optional(), // Custom display name for the machine
    // Daemon status fields
    daemonLastKnownStatus: z.enum(['running', 'shutting-down']).optional(),
    daemonLastKnownPid: z.number().optional(),
    shutdownRequestedAt: z.number().optional(),
    shutdownSource: z.enum(['happy-app', 'happy-cli', 'os-signal', 'unknown']).optional(),
    cliAvailability: z.object({
        claude: z.boolean(),
        codex: z.boolean(),
        gemini: z.boolean(),
        openclaw: z.boolean(),
        detectedAt: z.number(),
    }).optional(),
    resumeSupport: z.object({
        rpcAvailable: z.boolean(),
        requiresSameMachine: z.boolean(),
        requiresHappyAgentAuth: z.boolean(),
        happyAgentAuthenticated: z.boolean(),
        detectedAt: z.number(),
    }).optional(),
});

export type MachineMetadata = z.infer<typeof MachineMetadataSchema>;

export interface Machine {
    id: string;
    seq: number;
    createdAt: number;
    updatedAt: number;
    active: boolean;
    activeAt: number;  // Changed from lastActiveAt to activeAt for consistency
    metadata: MachineMetadata | null;
    metadataVersion: number;
    daemonState: any | null;  // Dynamic daemon state (runtime info)
    daemonStateVersion: number;
}

//
// Git Status
//

export interface GitStatus {
    branch: string | null;
    isDirty: boolean;
    modifiedCount: number;
    untrackedCount: number;
    stagedCount: number;
    lastUpdatedAt: number;
    // Line change statistics - separated by staged vs unstaged
    stagedLinesAdded: number;
    stagedLinesRemoved: number;
    unstagedLinesAdded: number;
    unstagedLinesRemoved: number;
    // Computed totals
    linesAdded: number;      // stagedLinesAdded + unstagedLinesAdded
    linesRemoved: number;    // stagedLinesRemoved + unstagedLinesRemoved
    linesChanged: number;    // Total lines that were modified (added + removed)
    // Branch tracking information (from porcelain v2)
    upstreamBranch?: string | null; // Name of upstream branch
    aheadCount?: number; // Commits ahead of upstream
    behindCount?: number; // Commits behind upstream
    stashCount?: number; // Number of stash entries
}
