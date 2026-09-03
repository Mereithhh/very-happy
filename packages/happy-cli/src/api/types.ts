import { z } from 'zod'
import type { Update, UpdateMachineBody } from '@slopus/happy-wire';
import type { ReleaseDrainNotice } from '@slopus/happy-wire';
import { UsageSchema } from '@/claude/types'
import type { SandboxConfig } from '@/persistence'

export {
  SessionMessageContentSchema,
  SessionMessageSchema,
  UpdateBodySchema,
  UpdateMachineBodySchema,
  UpdateSchema,
  UpdateSessionBodySchema,
} from '@slopus/happy-wire';
export type {
  SessionMessage,
  SessionMessageContent,
  Update,
  UpdateBody,
  UpdateMachineBody,
  UpdateSessionBody,
} from '@slopus/happy-wire';

/**
 * Permission mode type - includes both Claude and Codex modes
 * Must match MessageMetaSchema.permissionMode enum values
 *
 * Claude modes: default, acceptEdits, bypassPermissions, plan
 * Codex modes: read-only, safe-yolo, yolo
 *
 * When calling Claude SDK, Codex modes are mapped at the SDK boundary:
 * - yolo → bypassPermissions
 * - safe-yolo → default
 * - read-only → default
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'read-only' | 'safe-yolo' | 'yolo'

/**
 * Usage data type from Claude
 */
export type Usage = z.infer<typeof UsageSchema>

/**
 * Socket events from server to client
 */
export interface ServerToClientEvents {
  update: (data: Update) => void
  'rpc-request': (data: { method: string, params: string }, callback: (response: string) => void) => void
  'rpc-registered': (data: { method: string }) => void
  'session-archive': (data: { sessionId: string }) => void
  'rpc-unregistered': (data: { method: string }) => void
  'rpc-error': (data: { type: string, error: string }) => void
  ephemeral: (data: { type: 'activity', id: string, active: boolean, activeAt: number, thinking: boolean }) => void
  auth: (data: { success: boolean, user: string }) => void
  error: (data: { message: string }) => void
  'server-draining': (data: ReleaseDrainNotice) => void
}


/**
 * Socket events from client to server
 */
export interface ClientToServerEvents {
  'release-handover-result': (data: { result: 'success' | 'failed'; durationMs: number }) => void
  message: (data: { sid: string, message: any }) => void
  'session-alive': (data: {
    sid: string;
    time: number;
    thinking: boolean;
    mode?: 'local' | 'remote';
  }) => void
  'session-end': (data: { sid: string, time: number }) => void,
  // Clipboard push: session → server → all of the user's web clients.
  // `payload` is the clipboard text, encrypted with the session key when
  // `enc` is true. `truncated`/`totalBytes` describe producer-side capping.
  'clipboard-push': (data: { payload: string, enc?: boolean, truncated?: boolean, totalBytes?: number }) => void,
  /** B-309: encrypted live stream frame; relayed, never stored. */
  'session-stream': (data: { payload: string, enc?: boolean }) => void,
  // B-131 file preview push: session → server → all of the user's web clients.
  // `payload` is the file's ABSOLUTE PATH (not its contents), encrypted with the
  // session key when `enc` is true. The web client reads the file itself over the
  // existing fs-read RPC — that keeps this relay tiny and adds no new file access.
  'file-preview-push': (data: { payload: string, enc?: boolean, mode?: 'file' | 'diff' }) => void,
  'update-metadata': (data: { sid: string, expectedVersion: number, metadata: string }, cb: (answer: {
    // B-307: the server has always named account-resource refusals here
    // (`<resource>_rate_quota_exceeded`); this side just never declared it, so
    // no client could tell "back off for a minute" from "retry immediately".
    result: 'error',
    error?: string
  } | {
    result: 'version-mismatch'
    version: number,
    metadata: string
  } | {
    result: 'success',
    version: number,
    metadata: string
  }) => void) => void,
  'update-state': (data: { sid: string, expectedVersion: number, agentState: string | null }, cb: (answer: {
    result: 'error',
    error?: string   // B-307, as above
  } | {
    result: 'version-mismatch'
    version: number,
    agentState: string | null
  } | {
    result: 'success',
    version: number,
    agentState: string | null
  }) => void) => void,
  'ping': (callback: () => void) => void
  'rpc-register': (data: { method: string }) => void
  'rpc-unregister': (data: { method: string }) => void
  'rpc-call': (data: { method: string, params: string }, callback: (response: {
    ok: boolean
    result?: string
    error?: string
  }) => void) => void
  'usage-report': (data: {
    key: string
    sessionId: string
    tokens: {
      total: number
      [key: string]: number
    }
    cost: {
      total: number
      [key: string]: number
    }
  }) => void
}

/**
 * Session information
 */
export type Session = {
  id: string,
  seq: number,
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  metadata: Metadata,
  metadataVersion: number,
  agentState: AgentState | null,
  agentStateVersion: number,
}

/**
 * Machine metadata - static information (rarely changes)
 */
export const MachineMetadataSchema = z.object({
  host: z.string(),
  platform: z.string(),
  happyCliVersion: z.string(),
  homeDir: z.string(),
  happyHomeDir: z.string(),
  happyLibDir: z.string(),
  cliAvailability: z.object({
    claude: z.boolean(),
    codex: z.boolean(),
    gemini: z.boolean(),
    openclaw: z.boolean(),
    pi: z.boolean().optional(), // absent on daemons that predate the pi runner
    detectedAt: z.number(),
  }).optional(),
  resumeSupport: z.object({
    rpcAvailable: z.boolean(),
    requiresSameMachine: z.boolean(),
    requiresHappyAgentAuth: z.boolean(),
    happyAgentAuthenticated: z.boolean(),
    detectedAt: z.number(),
  }).optional(),
})

export type MachineMetadata = z.infer<typeof MachineMetadataSchema>

export const ClaudeAuthStateSchema = z.object({
  probeVersion: z.number(),
  daemonPid: z.number(),
  status: z.union([z.enum(['ok', 'not-logged-in', 'unknown', 'error', 'claude-missing']), z.string()]),
  authMethod: z.string().optional(),
  subscriptionType: z.string().optional(),
  diagnosis: z.string().optional(),
  detail: z.string().optional(),
  repairable: z.string().optional(),
  context: z.object({
    platform: z.string(),
    lineage: z.string(),
    credentialStore: z.string(),
  }),
  checkedAt: z.number(),
})

export const CliUpdateStateSchema = z.object({
  currentVersion: z.string(),
  recommendedVersion: z.string().nullable(),
  minimumVersion: z.string().nullable(),
  status: z.enum(['current', 'available', 'required']),
  checkedAt: z.number(),
  /**
   * B-321: a new bundle is on disk but refused to run, so the daemon is still
   * serving the old code. Present only while that is true. Optional and additive:
   * old web builds ignore it, old daemons never send it (iron rule 4).
   */
  handoverHold: z.object({ reason: z.string(), at: z.number() }).nullable().optional(),
  /** B-327: the last thing the machine's auto-update did, or why it did nothing. */
  autoUpdate: z.object({
    state: z.union([z.enum(['installing', 'installed', 'failed', 'skipped']), z.string()]),
    version: z.string().nullable(),
    detail: z.string().optional(),
    at: z.number(),
  }).nullable().optional(),
})

export type CliUpdateState = z.infer<typeof CliUpdateStateSchema>

/**
 * One web terminal in the machine's pushed terminal list (same item shape the
 * `list-terminals` RPC returns, so old polling clients and the push describe
 * the same thing).
 */
export const WebTerminalListItemSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  /** New daemons always send an array (including []); absence identifies an
   * old daemon that cannot persist terminal tags. */
  tags: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  createdAt: z.number().optional(),
  activityAt: z.number().optional(),
  agentState: z.enum(['working', 'needs_input', 'idle', 'shell']).optional(),
  /** B-105: mirror session of the claude running inside the terminal. */
  mirrorSessionId: z.string().optional(),
  /** B-150: auto-restored after a restart (ms epoch) — the directory and the
   *  conversation carried over, the processes did not. Cleared once opened. */
  restoredAt: z.number().optional(),
  /** B-265: @vh_title_manual is set (user renamed it). */
  manual: z.boolean().optional(),
  /** B-273: opened attached to the user's tmux session of this name. */
  attachTmux: z.string().optional(),
})

/**
 * One recently CLOSED terminal (B-084) — see terminal/closedTerminals.ts for
 * the list rules (newest first, dedupe by id, capped at 20). Shipped inside
 * daemonState.closedTerminals so the web's archive view can show ended
 * terminals and offer "new terminal in the same directory" (cwd).
 */
export const ClosedTerminalRecordSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  cwd: z.string().optional(),
  /** B-105: shadow mirror session — structured history of the claude that ran
   *  inside the terminal, still reachable after the terminal is gone. */
  mirrorSessionId: z.string().optional(),
  /** B-149: claude conversation id, for one-click resume of a dead terminal. */
  claudeSessionId: z.string().optional(),
  /** B-149: 'daemon-gap' = died while no daemon was watching (restart/reboot);
   *  absent means an ordinary observed close. */
  reason: z.enum(['closed', 'daemon-gap']).optional(),
  /** B-265: tags + manual-rename flag at close time (restored verbatim). */
  tags: z.array(z.string()).optional(),
  manual: z.boolean().optional(),
  /** B-273: attached user tmux session name — restore re-attaches. */
  attachTmux: z.string().optional(),
  closedAt: z.number(),
})

/**
 * Daemon state - dynamic runtime information (frequently updated)
 */
export const DaemonStateSchema = z.object({
  status: z.union([
    z.enum(['running', 'shutting-down']),
    z.string() // Forward compatibility
  ]),
  pid: z.number().optional(),
  httpPort: z.number().optional(),
  startedAt: z.number().optional(),
  shutdownRequestedAt: z.number().optional(),
  shutdownSource:
    z.union([
      z.enum(['mobile-app', 'cli', 'os-signal', 'unknown']),
      z.string() // Forward compatibility
    ]).optional(),
  /**
   * Push channel for this machine's web-terminal list (see
   * terminal/webTerminal.ts list tracking). The daemon rewrites this field
   * whenever the tracked list signature changes; the server persists it with
   * the rest of daemonState and broadcasts `update-machine`, so every web
   * client gets the terminal list/titles/agent states pushed instead of
   * polling `list-terminals` — and an OFFLINE machine's last list stays
   * readable from the server's persisted copy.
   *
   * Trust rule for consumers: the snapshot is only authoritative when
   * `updatedAt >= startedAt` — i.e. it was written by the CURRENT daemon run.
   * A downgraded daemon spreads the stale field forward (`{...state}`) but
   * bumps `startedAt` on connect without restamping `updatedAt`, which is
   * exactly what makes clients fall back to polling. Old clients ignore the
   * field entirely.
   */
  webTerminals: z.object({
    updatedAt: z.number(),
    terminals: z.array(WebTerminalListItemSchema),
  }).optional(),
  /**
   * Recently closed terminals (B-084), newest first, capped at 20 — written
   * alongside webTerminals in the same daemonState pushes (every close also
   * changes the live list, so the two always travel together). Old clients
   * ignore the field; old daemons never write it (web renders nothing).
   */
  closedTerminals: z.array(ClosedTerminalRecordSchema).optional(),
  /**
   * B-265 capability flag: this daemon answers `restore-terminal`. Same trust
   * rule as webTerminals — only `detectedAt >= startedAt` counts, because a
   * downgraded daemon spreads the stale field forward on connect.
   */
  terminalRestore: z.object({
    rpcAvailable: z.boolean(),
    detectedAt: z.number(),
  }).optional(),
  /**
   * B-273 capability flag: this daemon answers `list-tmux-sessions` and
   * honours `open-terminal.attachTmux`. Same trust rule (`detectedAt >=
   * startedAt`). Stamped unconditionally — on a machine without tmux the
   * RPC just answers an empty list.
   */
  tmuxSessions: z.object({
    rpcAvailable: z.boolean(),
    detectedAt: z.number(),
    /** B-282: `kill-terminal` honours `alsoAttached`. */
    killAttached: z.boolean().optional(),
  }).optional(),
  /**
   * B-290 capability flag: this daemon answers `claude-list-history` (import a
   * Claude Code conversation that was never started through very-happy).
   * Same trust rule (`detectedAt >= startedAt`).
   */
  claudeHistory: z.object({
    rpcAvailable: z.boolean(),
    detectedAt: z.number(),
  }).optional(),
  /** Relay-owned CLI compatibility/update policy last checked by this daemon. */
  cliUpdate: CliUpdateStateSchema.optional(),
  /**
   * B-276: result of the daemon-context Claude auth preflight (spec
   * 2026-09-claude-auth-preflight). Trust rule for consumers:
   * `claudeAuth.daemonPid === daemonState.pid` — daemonState survives daemon
   * restarts (the server returns the existing row and connect spreads it
   * forward), so a downgraded daemon carries this field along unchanged.
   */
  claudeAuth: ClaudeAuthStateSchema.optional(),
})

export type DaemonState = z.infer<typeof DaemonStateSchema>
export type ClaudeAuthState = import('@/daemon/claudeAuth/claudeAuthProbe').ClaudeAuthState

export type Machine = {
  id: string,
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  metadata: MachineMetadata,
  metadataVersion: number,
  daemonState: DaemonState | null,
  daemonStateVersion: number,
}

/**
 * Message metadata schema
 */
export const MessageMetaSchema = z.object({
  sentFrom: z.string().optional(), // Source identifier
  permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'read-only', 'safe-yolo', 'yolo']).optional(), // Permission mode for this message
  model: z.string().nullable().optional(), // Model name for this message (null = reset)
  fallbackModel: z.string().nullable().optional(), // Fallback model for this message (null = reset)
  customSystemPrompt: z.string().nullable().optional(), // Custom system prompt for this message (null = reset)
  appendSystemPrompt: z.string().nullable().optional(), // Append to system prompt for this message (null = reset)
  allowedTools: z.array(z.string()).nullable().optional(), // Allowed tools for this message (null = reset)
  disallowedTools: z.array(z.string()).nullable().optional(), // Disallowed tools for this message (null = reset)
  /**
   * Thinking depth for this message (null = reset to the machine default).
   * Deliberately a plain string, not an enum: an unknown value must not make
   * zod reject the WHOLE message the way the `dontAsk` permission enum did
   * (AGENTS 铁律 14). runClaude validates it against its own allow-list and
   * ignores anything else. Absent here until 0.2.105, which is why every
   * released CLI silently dropped the web's effort selection.
   */
  effort: z.string().nullable().optional(),
  /** Omitted/queue waits for the current turn; steer targets the live turn. */
  delivery: z.enum(['queue', 'steer']).optional()
})

export type MessageMeta = z.infer<typeof MessageMetaSchema>

/**
 * API response types
 */
export const CreateSessionResponseSchema = z.object({
  session: z.object({
    id: z.string(),
    tag: z.string(),
    seq: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
    metadata: z.string(),
    metadataVersion: z.number(),
    agentState: z.string().nullable(),
    agentStateVersion: z.number()
  })
})

export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>

export const UserMessageSchema = z.object({
  role: z.literal('user'),
  content: z.object({
    type: z.literal('text'),
    text: z.string()
  }),
  localKey: z.string().optional(), // Mobile messages include this
  meta: MessageMetaSchema.optional()
})

export type UserMessage = z.infer<typeof UserMessageSchema>

/**
 * File event message — sent by the app as a session envelope before the text message.
 * Contains a ref pointing to the encrypted blob on the server.
 */
export const FileEventMessageSchema = z.object({
  role: z.literal('session'),
  content: z.object({
    type: z.literal('session'),
    data: z.object({
      id: z.string(),
      time: z.number(),
      role: z.literal('user'),
      ev: z.object({
        t: z.literal('file'),
        ref: z.string(),
        name: z.string(),
        size: z.number(),
        mimeType: z.string().optional(),
        image: z.object({
          width: z.number(),
          height: z.number(),
          // Optional — native iOS picker has no Canvas to compute thumbhash.
          // App-side schema relaxed this in the same commit; keeping CLI in
          // sync so the file event isn't silently rejected by Zod and the
          // attachment never reaches Claude.
          thumbhash: z.string().optional(),
        }).optional(),
      }),
    }),
  }),
})

export type FileEventMessage = z.infer<typeof FileEventMessageSchema>

export const AgentMessageSchema = z.object({
  role: z.literal('agent'),
  content: z.object({
    type: z.literal('output'),
    data: z.any()
  }),
  meta: MessageMetaSchema.optional()
})

export type AgentMessage = z.infer<typeof AgentMessageSchema>

export const MessageContentSchema = z.union([UserMessageSchema, AgentMessageSchema])

export type MessageContent = z.infer<typeof MessageContentSchema>

export type Metadata = {
  /**
   * ACP session config option value (normalized for UI metadata consumers).
   */
  // `code` = protocol value ID, `value` = human label
  models?: Array<{ code: string; value: string; description?: string | null }>,
  currentModelCode?: string,
  /** Resolved SDK model when no per-message model override was supplied. */
  defaultModelCode?: string,
  operatingModes?: Array<{ code: string; value: string; description?: string | null }>,
  currentOperatingModeCode?: string,
  thoughtLevels?: Array<{ code: string; value: string; description?: string | null }>,
  currentThoughtLevelCode?: string,
  path: string,
  host: string,
  version?: string,
  name?: string,
  os?: string,
  summary?: {
    text: string,
    updatedAt: number
  },
  machineId?: string,
  claudeSessionId?: string, // Claude Code session ID
  /**
   * Terminal mirror (B-105): the vh web terminal this shadow session mirrors
   * (flavor === 'terminal-mirror'). Lets the web link mirror ↔ terminal both
   * ways. Absent on every other session; old clients ignore it.
   */
  terminalId?: string,
  codexThreadId?: string, // Codex app-server thread ID
  tools?: string[],
  slashCommands?: string[],
  mcpServers?: Array<{ name: string; status: string }>,
  skills?: string[],
  /** Attachment content blocks this daemon can forward to the active SDK. */
  attachmentKinds?: string[],
  /** Pending user messages can be canceled by stable transport id. */
  queueCancellation?: boolean,
  /** Explicit feature negotiation; old CLIs omit this field. */
  capabilities?: string[],
  homeDir: string,
  happyHomeDir: string,
  happyLibDir: string,
  happyToolsDir: string,
  startedFromDaemon?: boolean,
  hostPid?: number,
  startedBy?: 'daemon' | 'terminal',
  // Lifecycle state management
  lifecycleState?: 'running' | 'archiveRequested' | 'archived' | string,
  lifecycleStateSince?: number,
  archivedBy?: string,
  archiveReason?: string,
  flavor?: string
  sandbox?: SandboxConfig | null
  dangerouslySkipPermissions?: boolean | null
  /**
   * Effective permission mode the running Claude process enforces right now
   * (SDK vocabulary: default | acceptEdits | bypassPermissions | plan). The
   * CLI is the single source of truth: it writes this at start, on every
   * message/RPC/plan-approval change. Web displays it verbatim; old clients
   * ignore it and old CLIs never write it (capability claude-live-permission-v2).
   */
  permissionMode?: string
  /** Lineage for sessions created via the fork / duplicate flow. */
  parentSessionId?: string
  forkedFromMessageId?: string
  /**
   * B-290: the Claude conversation this session was imported from (the
   * on-disk transcript written by claude CLI / desktop / claude.ai that was
   * copied by `claude-fork-session`). Lets the import picker hide originals
   * that already have a copy here. Absent on every other session.
   */
  importedFromClaudeSessionId?: string
  /**
   * B-051: session variant. 'assistant' marks the machine's meta-agent
   * (dispatcher / voice assistant) session — fixed cwd ~/.happy/assistant,
   * singleton tag, assistant MCP tool surface. Absent on normal sessions;
   * old clients ignore the field (plain TS metadata, no zod).
   */
  variant?: 'assistant' | string
  /**
   * User-visible session tags (web renders them as chips; `#tag` search).
   * Optional only — never write an empty array. B-091: sessions dispatched BY
   * the assistant (HAPPY_SPAWNED_BY=assistant) are born with ['assistant'] so
   * they're recognizable in every list; old web clients just render one more
   * chip (harmless).
   */
  tags?: string[]
  /**
   * Task Board V2: latest LLM analysis of this session (boardAnalyzer).
   * Rides the normal metadata sync to every device; absent until the
   * daemon-local `boardLlm` opt-in produces a first verdict.
   */
  board?: {
    /** board task (KV vh.board-tasks.v1) this session was classified under */
    taskId?: string,
    attention?: 'none' | 'review' | 'blocked',
    /** one-line Chinese progress note */
    progress?: string,
    analyzedAt: number,
  }
};

export type AgentState = {
  controlledByUser?: boolean | null | undefined
  requests?: {
    [id: string]: {
      tool: string,
      arguments: any,
      createdAt: number,
      kind?: 'tool' | 'elicitation' | 'user_dialog',
      permissionSuggestions?: import('@anthropic-ai/claude-agent-sdk').PermissionUpdate[]
    }
  }
  completedRequests?: {
    [id: string]: {
      tool: string,
      arguments: any,
      createdAt: number,
      completedAt: number,
      status: 'canceled' | 'denied' | 'approved',
      reason?: string,
      mode?: PermissionMode,
      decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort',
      allowedTools?: string[]
    }
  }
}
