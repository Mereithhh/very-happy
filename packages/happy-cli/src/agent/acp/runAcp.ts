import { BUILTIN_TODO_DISCOVERY } from '@/modules/todo/skill';
import { registerAgentAttachmentDownloads } from '@/utils/agentAttachments';
import { configuration } from '@/configuration';
import { appendStagedAttachmentsToPrompt, stageClaudeAttachments, CLAUDE_ATTACHMENT_KINDS } from '@/claude/utils/attachmentContent';
import { preparePiTeamsRuntime } from '@/teams/piRuntime';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentMessage } from '@/agent/core';
import { AcpBackend, type AcpPermissionHandler } from './AcpBackend';
import { DefaultTransport } from '@/agent/transport';
import { AcpSessionManager } from './AcpSessionManager';
import type { SessionEnvelope } from '@slopus/happy-wire';
import { logger } from '@/ui/logger';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { Credentials, readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { encodeBase64 } from '@/api/encryption';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { StreamRelay } from '@/claude/streamRelay';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { projectPath } from '@/projectPath';
import { BasePermissionHandler, type PermissionResult } from '@/utils/BasePermissionHandler';
import { connectionState } from '@/utils/serverConnectionErrors';
import { TitleGenerator } from '@/claude/utils/titleGenerator';
import {
  normalizeAcpPermissionMode,
  removeSessionModeFile,
  writeSessionModeFile,
  type AcpPermissionMode,
} from './sessionModeFile';
import {
  extractConfigOptionsFromPayload,
  extractCurrentModeIdFromPayload,
  extractModeStateFromPayload,
  extractModelStateFromPayload,
  mergeAcpSessionConfigIntoMetadata,
} from './sessionConfigMetadata';
import type { SessionConfigOption, SessionModeState, SessionModelState } from '@agentclientprotocol/sdk';

const TURN_TIMEOUT_MS = 5 * 60 * 1000;
const ACP_EVENT_PREVIEW_CHARS = 240;
const ACP_RAW_PREVIEW_CHARS = 2000;
const ACP_COLOR_RESET = '\u001b[0m';
const ACP_LOG_COLORS = {
  muted: '\u001b[90m',
  error: '\u001b[31m',
  incoming: '\u001b[32m',
  outgoing: '\u001b[34m',
  tool: '\u001b[38;5;208m',
} as const;

type AcpLogKind = keyof typeof ACP_LOG_COLORS;
type AcpFormattedLog = {
  kind: AcpLogKind;
  text: string;
};

function shouldUseColoredAcpLogs(): boolean {
  if (process.env.FORCE_COLOR === '0') {
    return false;
  }
  if (process.env.FORCE_COLOR !== undefined) {
    return true;
  }
  return process.stdout.isTTY === true || process.stderr.isTTY === true;
}

function formatAcpTime(date: Date = new Date()): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function colorizeAcpLine(kind: AcpLogKind, line: string): string {
  if (!shouldUseColoredAcpLogs()) {
    return line;
  }
  return `${ACP_LOG_COLORS[kind]}${line}${ACP_COLOR_RESET}`;
}

function logAcp(kind: AcpLogKind, message: string): void {
  const line = `[${formatAcpTime()}] ${message}`;
  console.log(colorizeAcpLine(kind, line));
}

function toSingleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateForConsole(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}...`;
}

function formatUnknownForConsole(value: unknown, limit: number): string {
  let serialized = '';
  if (typeof value === 'string') {
    serialized = value;
  } else {
    try {
      serialized = JSON.stringify(value);
    } catch {
      serialized = String(value);
    }
  }
  return truncateForConsole(toSingleLine(serialized), limit);
}

function formatTextForConsole(text: string): string {
  return JSON.stringify(truncateForConsole(toSingleLine(text), ACP_EVENT_PREVIEW_CHARS));
}

function formatOptionalDetail(text: string | null | undefined, limit = ACP_EVENT_PREVIEW_CHARS): string {
  if (!text) {
    return '';
  }
  return ` - ${truncateForConsole(toSingleLine(text), limit)}`;
}

function extractThinkingText(payload: unknown): string {
  if (typeof payload === 'string') {
    return payload;
  }
  if (payload && typeof payload === 'object' && typeof (payload as { text?: unknown }).text === 'string') {
    return (payload as { text: string }).text;
  }
  return '';
}

function formatAcpMessageForFrontend(agentName: string, msg: AgentMessage, detailed: boolean): AcpFormattedLog | null {
  switch (msg.type) {
    case 'status':
      return null;
    case 'model-output': {
      const text = msg.textDelta ?? msg.fullText ?? '';
      return {
        kind: 'outgoing',
        text: `Outgoing message: ${formatTextForConsole(text)}`,
      };
    }
    case 'tool-call':
      return {
        kind: 'tool',
        text: `Tool: ${msg.toolName} started (callId=${msg.callId})`,
      };
    case 'tool-result':
      return {
        kind: 'tool',
        text: `Tool: ${msg.toolName} completed (callId=${msg.callId})`,
      };
    case 'permission-request':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing permission request from ${agentName}: id=${msg.id} reason=${msg.reason}`,
      };
    case 'permission-response':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing permission response from ${agentName}: id=${msg.id} approved=${msg.approved}`,
      };
    case 'fs-edit':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing fs edit from ${agentName}: description=${formatTextForConsole(msg.description)}`,
      };
    case 'terminal-output':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing terminal output from ${agentName}: text=${formatTextForConsole(msg.data)}`,
      };
    case 'event': {
      if (msg.name === 'thinking') {
        const thinkingText = extractThinkingText(msg.payload);
        return {
          kind: 'muted',
          text: `Thinking: ${formatTextForConsole(thinkingText)}`,
        };
      }
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing event from ${agentName}: name=${msg.name} payload=${formatUnknownForConsole(msg.payload, ACP_EVENT_PREVIEW_CHARS)}`,
      };
    }
    case 'token-count':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing token count from ${agentName}: data=${formatUnknownForConsole(msg, ACP_EVENT_PREVIEW_CHARS)}`,
      };
    case 'exec-approval-request':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing exec approval request from ${agentName}: callId=${msg.call_id}`,
      };
    case 'patch-apply-begin':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing patch apply begin from ${agentName}: callId=${msg.call_id} autoApproved=${msg.auto_approved === true}`,
      };
    case 'patch-apply-end':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing patch apply end from ${agentName}: callId=${msg.call_id} success=${msg.success}`,
      };
    default:
      return null;
  }
}

function formatEnvelopeForServerLog(agentName: string, envelope: SessionEnvelope): AcpFormattedLog {
  if (envelope.ev.t === 'text') {
    const thinkingPrefix = envelope.ev.thinking ? 'thinking' : 'text';
    return {
      kind: 'incoming',
      text: `Incoming ${thinkingPrefix} prompt for ${agentName}: ${formatUnknownForConsole(envelope.ev.text, ACP_EVENT_PREVIEW_CHARS)}`,
    };
  }
  if (envelope.ev.t === 'tool-call-start') {
    return {
      kind: 'tool',
      text: `Tool start sent to server from ${agentName}: tool=${envelope.ev.name} callId=${envelope.ev.call} args=${formatUnknownForConsole(envelope.ev.args, ACP_EVENT_PREVIEW_CHARS)}`,
    };
  }
  if (envelope.ev.t === 'tool-call-end') {
    return {
      kind: 'tool',
      text: `Tool end sent to server from ${agentName}: callId=${envelope.ev.call}`,
    };
  }
  if (envelope.ev.t === 'turn-start') {
    return {
      kind: 'incoming',
      text: `Incoming turn start for ${agentName}`,
    };
  }
  if (envelope.ev.t === 'turn-end') {
    return {
      kind: 'incoming',
      text: `Incoming turn end for ${agentName}: status=${envelope.ev.status}`,
    };
  }
  return {
    kind: 'incoming',
    text: `Incoming ${envelope.ev.t} for ${agentName}: ${formatUnknownForConsole(envelope.ev, ACP_EVENT_PREVIEW_CHARS)}`,
  };
}

type AcpSwitchMode = {
  permissionMode?: string;
  model?: string | null;
  effort?: string | null;
};

type AcpSelectableOption = {
  code: string;
  value: string;
};

type AcpConfigSelector = {
  configId: string;
  currentCode: string;
  options: AcpSelectableOption[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function isSelectValue(value: unknown): value is { value: string; name: string } {
  return isRecord(value) && typeof value.value === 'string' && typeof value.name === 'string';
}

function isSelectGroup(value: unknown): value is { options: unknown[] } {
  return isRecord(value) && Array.isArray(value.options);
}

function flattenSelectOptions(options: unknown): AcpSelectableOption[] {
  if (!Array.isArray(options)) {
    return [];
  }

  const flattened: AcpSelectableOption[] = [];

  for (const entry of options) {
    if (isSelectValue(entry)) {
      flattened.push({ code: entry.value, value: entry.name });
      continue;
    }
    if (isSelectGroup(entry)) {
      for (const grouped of entry.options) {
        if (!isSelectValue(grouped)) {
          continue;
        }
        flattened.push({ code: grouped.value, value: grouped.name });
      }
    }
  }

  return flattened;
}

export function extractConfigSelector(
  configOptions: SessionConfigOption[],
  category: 'mode' | 'model' | 'thought_level',
): AcpConfigSelector | null {
  const optionMatchesCategory = (option: SessionConfigOption): boolean => {
    if (option.category === category) {
      return true;
    }
    // An option that declares a different category is never a fallback
    // candidate: pi-acp's `model` option (category 'model') used to be taken
    // for the *mode* selector because 'model'.includes('mode'), which routed
    // every permission-mode switch of a pi session into the model picker and
    // kept the session-modes file (the gate's live-switch channel) from ever
    // being written (B-351).
    if (option.category) {
      return false;
    }
    // Some ACP providers omit category; fallback to id/name heuristics.
    const id = normalizeComparable(option.id);
    const name = normalizeComparable(option.name);
    if (category === 'thought_level') return id.includes('thinking') || id.includes('thought') || name.includes('thinking');
    if (category === 'model') {
      return id.includes('model') || name.includes('model');
    }
    const mentionsMode = (value: string): boolean => value.includes('permission') || (value.includes('mode') && !value.includes('model'));
    return mentionsMode(id) || mentionsMode(name);
  };

  for (const option of configOptions) {
    if (option.type !== 'select' || !optionMatchesCategory(option)) {
      continue;
    }
    return {
      configId: option.id,
      currentCode: option.currentValue,
      options: flattenSelectOptions(option.options),
    };
  }
  return null;
}

function normalizeComparable(value: string): string {
  return value.trim().toLowerCase();
}

function resolveRequestedCode(options: AcpSelectableOption[], requested: string): string | null {
  for (const option of options) {
    if (option.code === requested || option.value === requested) {
      return option.code;
    }
  }

  const normalizedRequested = normalizeComparable(requested);
  for (const option of options) {
    if (normalizeComparable(option.code) === normalizedRequested || normalizeComparable(option.value) === normalizedRequested) {
      return option.code;
    }
  }

  return null;
}

function resolveRequestedLegacyModeCode(modes: SessionModeState, requested: string): string | null {
  for (const mode of modes.availableModes) {
    if (mode.id === requested || mode.name === requested) {
      return mode.id;
    }
  }

  const normalizedRequested = normalizeComparable(requested);
  for (const mode of modes.availableModes) {
    if (normalizeComparable(mode.id) === normalizedRequested || normalizeComparable(mode.name) === normalizedRequested) {
      return mode.id;
    }
  }

  return null;
}

function resolveRequestedLegacyModelCode(models: SessionModelState, requested: string): string | null {
  for (const model of models.availableModels) {
    if (model.modelId === requested || model.name === requested) {
      return model.modelId;
    }
  }

  const normalizedRequested = normalizeComparable(requested);
  for (const model of models.availableModels) {
    if (normalizeComparable(model.modelId) === normalizedRequested || normalizeComparable(model.name) === normalizedRequested) {
      return model.modelId;
    }
  }

  return null;
}

class GenericAcpPermissionHandler extends BasePermissionHandler implements AcpPermissionHandler {
  private readonly logPrefix: string;

  constructor(session: ApiSessionClient, agentName: string) {
    super(session);
    this.logPrefix = `[${agentName}]`;
  }

  protected getLogPrefix(): string {
    return this.logPrefix;
  }

  async handleToolCall(toolCallId: string, toolName: string, input: unknown): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve, reject) => {
      this.pendingRequests.set(toolCallId, {
        resolve,
        reject,
        toolName,
        input,
      });
      this.addPendingRequestToState(toolCallId, toolName, input);
      logger.debug(`${this.logPrefix} Permission request sent for tool: ${toolName} (${toolCallId})`);
    });
  }
}

type PendingTurn = {
  resolve: () => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
};

function resolveSessionFlavor(agentName: string): 'gemini' | 'opencode' | 'acp' {
  if (agentName === 'gemini') {
    return 'gemini';
  }
  if (agentName === 'opencode') {
    return 'opencode';
  }
  return 'acp';
}

export async function runAcp(opts: {
  model?: string;
  credentials: Credentials;
  agentName: string;
  command: string;
  args: string[];
  startedBy?: 'daemon' | 'terminal';
  verbose?: boolean;
  /**
   * Initial permission mode (`--permission-mode`, already sanitized). Exported
   * to the agent child as HAPPY_PERMISSION_MODE and, for agents without a mode
   * selector, published through the session mode file + metadata.
   */
  permissionMode?: AcpPermissionMode;
  /**
   * Called when the backend reports `status: 'error'` (e.g. the adapter
   * executable is missing). That path stops the runner without throwing, so a
   * caller that wants to print guidance cannot rely on its outer catch.
   */
  onBackendError?: (detail: string | undefined) => void;
}): Promise<void> {
  const verbose = opts.verbose === true;
  const sessionTag = randomUUID();
  connectionState.setBackend(opts.agentName);

  const api = await ApiClient.create(opts.credentials);
  const settings = await readSettings();
  if (!settings?.machineId) {
    throw new Error('No machine ID found in settings');
  }

  await api.getOrCreateMachine({
    machineId: settings.machineId,
    metadata: initialMachineMetadata,
  });

  const { state, metadata } = createSessionMetadata({
    flavor: resolveSessionFlavor(opts.agentName),
    ...(process.env.VH_TEAM_OPERATION_ID ? { teamOperationId: process.env.VH_TEAM_OPERATION_ID } : {}),
    machineId: settings.machineId,
    startedBy: opts.startedBy,
    sandbox: settings.sandboxConfig,
  });
  metadata.attachmentKinds = [];
  const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
  if (response) {
    logAcp('muted', `Happy Session ID: ${response.id}`);
  }

  let session: ApiSessionClient;
  let permissionHandler: GenericAcpPermissionHandler;
  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    onSessionSwap: (newSession) => {
      session = newSession;
      if (permissionHandler) {
        permissionHandler.updateSession(newSession);
      }
    },
  });
  session = initialSession;

  if (response) {
    try {
      await notifyDaemonSessionStarted(response.id, metadata, {
        encryptionKey: encodeBase64(response.encryptionKey),
        encryptionVariant: response.encryptionVariant,
        seq: response.seq,
        metadataVersion: response.metadataVersion,
        agentStateVersion: response.agentStateVersion,
      });
    } catch (error) {
      logger.debug('[acp] Failed to report session to daemon:', error);
    }
  }

  permissionHandler = new GenericAcpPermissionHandler(session, opts.agentName);
  // Drop any permission requests left in agent state from a previous CLI
  // process that died while a tool prompt was open — see the matching
  // call in claudeRemoteLauncher for the full rationale.
  permissionHandler.reset('Previous CLI process exited before responding');
  // B-309 for ACP (B-371): the mapper holds streamed text back until a type
  // switch / tool call / turn end, so without this bypass a pi answer with no
  // tool calls is invisible on the web until the turn is over. Same relay,
  // same off switch and same frames as the Claude SDK path; the turn id
  // stands in for the API message id. `session` is a `let` (reconnection may
  // swap it), hence the closure rather than a bound method.
  const streamingEnabled = process.env.HAPPY_SESSION_STREAM_DISABLED !== '1';
  const streamRelay = new StreamRelay({
    send: (frame) => session.sendStreamFrame(frame),
  });
  const sessionManager = new AcpSessionManager(streamingEnabled ? { stream: streamRelay } : {});
  const messageQueue = new MessageQueue2<AcpSwitchMode>((mode) => hashObject(mode));
  let currentPermissionMode: string | undefined;
  let currentModel: string | null | undefined;
  let modeSelector: AcpConfigSelector | null = null;
  let modelSelector: AcpConfigSelector | null = null;
  let thoughtSelector: AcpConfigSelector | null = null;
  let currentEffort: string | null | undefined;
  let legacyModes: SessionModeState | null = null;
  let legacyModels: SessionModelState | null = null;
  let sawSlashCommands = false;
  let sawModes = false;
  let sawModels = false;

  // Mode for agents without an ACP mode selector (pi). The gate on the agent
  // side reads it from the session mode file; the web reads it from metadata
  // (rule 14: publish what is in effect, not the intent).
  const initialPermissionMode: AcpPermissionMode = opts.permissionMode ?? 'default';
  // Set once startSession has shown there is no ACP mode selector.
  let fileBackedModeActive = false;
  // pi never has an ACP permission-mode selector: pi-acp advertises the *thinking
  // level* through the legacy `modes` field ("Thinking: off/low/…") and `model` /
  // `thought_level` config options, so the generic "does the agent expose a mode
  // selector?" test is wrong for it and used to route every permission switch of
  // a pi session into the thinking-level picker (B-351). The permission layer
  // for pi is the pi-side gate, fed through the session-modes file.
  const permissionModeIsFileBacked = (): boolean =>
    opts.agentName === 'pi' || (!modeSelector && !legacyModes);
  let fileBackedPermissionMode: AcpPermissionMode | null = null;
  // Returns false when the file could not be written: nothing is published
  // then, so the web keeps showing the mode that is really in effect.
  const publishFileBackedPermissionMode = (mode: AcpPermissionMode): boolean => {
    if (fileBackedPermissionMode === mode) {
      return true;
    }
    try {
      writeSessionModeFile(session.sessionId, mode);
    } catch (error) {
      logger.debug(`[${opts.agentName}] Failed to write session mode file:`, error);
      return false;
    }
    fileBackedPermissionMode = mode;
    session.updateMetadata((currentMetadata) => ({ ...currentMetadata, permissionMode: mode }));
    logger.debug(`[${opts.agentName}] Published file-backed permission mode: ${mode}`);
    return true;
  };

  // Mirrors runClaude: the daemon injects HAPPY_SESSION_VARIANT=assistant for the
  // meta-agent spawn (env-only, no .mcp.json); only the in-process MCP server
  // reached via HAPPY_MCP_URL can expose the sessions_* tools to a pi session.
  const isAssistantVariant = process.env.HAPPY_SESSION_VARIANT === 'assistant';
  const happyServer = await startHappyServer(session, {
    assistant: isAssistantVariant,
    ...(opts.agentName === 'pi' ? { onContextUsage: (contextUsage: import('@slopus/happy-wire').ContextUsage) => {
      session.updateAgentState(state => ({ ...state, contextUsage }));
    } } : {}),
  });
  if (opts.agentName === 'pi') session.updateAgentState(state => ({ ...state, contextUsage: null }));
  const mcpServers = {
    happy: {
      command: join(projectPath(), 'bin', 'very-happy-mcp.mjs'),
      args: ['--url', happyServer.url],
    },
  };

  // pi-acp ignores `mcpServers`, so the agent child also gets the in-process
  // happy MCP server by env: a pi extension (or any agent that reads env) can
  // connect to HAPPY_MCP_URL directly. `mcpServers` stays for agents that do
  // honour the ACP handoff.
  const teamsPiEnv = opts.agentName === 'pi' ? await preparePiTeamsRuntime() : {};
  const backend = new AcpBackend({
    agentName: opts.agentName,
    cwd: process.cwd(),
    command: opts.command,
    args: opts.args,
    env: {
      ...teamsPiEnv,
      HAPPY_MCP_URL: happyServer.url,
      ...(happyServer.contextUsageUrl ? { HAPPY_CONTEXT_USAGE_URL: happyServer.contextUsageUrl } : {}),
      HAPPY_SESSION_ID: session.sessionId,
      HAPPY_PERMISSION_MODE: initialPermissionMode,
    },
    mcpServers,
    permissionHandler,
    transportHandler: new DefaultTransport(opts.agentName),
    verbose,
  });

  // The keepAlive `thinking` lease is TURN-scoped, not backend-status-scoped
  // (B-376). The web has exactly one liveness signal — this 2s heartbeat
  // (`sync/agentLiveness.ts`, rule 13) — and it folds the turn's activity view
  // and removes the running status bar the moment it reads `false`. AcpBackend's
  // `status` is a text-gap heuristic, not a turn boundary: it emits `idle` 500ms
  // after the last text chunk and again whenever the last active tool call
  // completes (sessionUpdateHandlers.ts). A real pi turn probed on 2026-09-07
  // went running→idle→running→idle→(4.1s of model output)→prompt resolved, so
  // driving the lease off `status` made the web show "done" twice per turn while
  // pi was still working. The real turn boundary is `backend.sendPrompt()`
  // resolving (ACP `prompt` returns its stopReason only when the turn is over),
  // so the lease is held from `startTurn` to that point — same shape as
  // claudeRemote's `updateThinking` and runGemini's "set false ONCE in finally".
  let thinking = false;
  const setThinking = (next: boolean) => {
    if (thinking === next) {
      return;
    }
    thinking = next;
    session.keepAlive(thinking, 'remote');
  };
  let acpSessionId: string | null = null;
  let shouldExit = false;
  let abortController = new AbortController();
  let pendingTurn: PendingTurn | null = null;

  const clearPendingTurn = (error?: Error) => {
    if (!pendingTurn) {
      return;
    }
    clearTimeout(pendingTurn.timeout);
    const current = pendingTurn;
    pendingTurn = null;
    if (error) {
      current.reject(error);
      return;
    }
    current.resolve();
  };

  const waitForTurnEnd = () => new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingTurn = null;
      reject(new Error(`Timed out waiting for ${opts.agentName} to finish the turn`));
    }, TURN_TIMEOUT_MS);
    pendingTurn = { resolve, reject, timeout };
  });

  const stopRunnerFromBackendStatus = (status: 'error' | 'stopped', detail?: string) => {
    const reason = detail
      ? `${opts.agentName} backend ${status}: ${detail}`
      : `${opts.agentName} backend ${status}`;
    logger.debug(`[${opts.agentName}] ${reason}; stopping ACP runner`);
    shouldExit = true;
    messageQueue.close();
    clearPendingTurn(new Error(reason));
  };

  const sendEnvelopes = (envelopes: SessionEnvelope[]) => {
    for (const envelope of envelopes) {
      if (verbose) {
        const formatted = formatEnvelopeForServerLog(opts.agentName, envelope);
        logAcp('muted', formatted.text);
      }
      session.sendSessionProtocolMessage(envelope);
      if (verbose) {
        logAcp('muted', `Incoming raw envelope for ${opts.agentName}: ${formatUnknownForConsole(envelope, ACP_RAW_PREVIEW_CHARS)}`);
      }
    }
  };

  const switchPermissionModeIfRequested = async (requestedMode: string): Promise<void> => {
    if (!requestedMode) {
      return;
    }

    if (permissionModeIsFileBacked()) {
      // No ACP mode selector (pi-acp): the mode is enforced by a gate on the
      // agent side that re-reads the session mode file, so publish it there.
      const mode = normalizeAcpPermissionMode(requestedMode);
      if (!mode) {
        logger.debug(`[${opts.agentName}] Ignoring unknown file-backed permission mode request: ${requestedMode}`);
        return;
      }
      publishFileBackedPermissionMode(mode);
      return;
    }

    if (modeSelector) {
      const resolved = resolveRequestedCode(modeSelector.options, requestedMode);
      if (!resolved) {
        logger.debug(`[${opts.agentName}] Ignoring unknown ACP permission mode request: ${requestedMode}`);
        return;
      }
      if (resolved === modeSelector.currentCode) {
        return;
      }
      const switched = await backend.setSessionConfigOption(modeSelector.configId, resolved);
      if (switched) {
        modeSelector.currentCode = resolved;
        return;
      }
    }

    if (!legacyModes) {
      return;
    }

    const resolvedLegacyMode = resolveRequestedLegacyModeCode(legacyModes, requestedMode);
    if (!resolvedLegacyMode) {
      logger.debug(`[${opts.agentName}] Ignoring unknown ACP legacy mode request: ${requestedMode}`);
      return;
    }
    if (resolvedLegacyMode === legacyModes.currentModeId) {
      return;
    }

    const switched = await backend.setSessionMode(resolvedLegacyMode);
    if (switched) {
      legacyModes = {
        ...legacyModes,
        currentModeId: resolvedLegacyMode,
      };
    }
  };

  const switchEffortIfRequested = async (requested: string, modelChanged: boolean): Promise<void> => {
    const discardStaleEffort = (): void => {
      if (currentEffort === requested) currentEffort = null;
      session.sendSessionEvent({ type: 'message', message: `The new model does not support thinking level "${requested}"; using its current thinking level.` });
    };
    if (thoughtSelector) {
      const resolved = thoughtSelector.options.find((option) => option.code === requested)?.code;
      if (!resolved) {
        if (modelChanged) { discardStaleEffort(); return; }
        throw new Error(`Unsupported thinking level: ${requested}`);
      }
      if (resolved === thoughtSelector.currentCode) return;
      if (!await backend.setSessionConfigOption(thoughtSelector.configId, resolved)) {
        throw new Error(`Failed to switch thinking level to ${resolved}`);
      }
      thoughtSelector.currentCode = resolved;
      session.updateMetadata((metadata) => ({ ...metadata, currentThoughtLevelCode: resolved }));
      return;
    }
    // pi-acp's legacy modes are thinking levels. Permissions still go solely
    // through the file-backed gate above, never through this selector.
    if (permissionModeIsFileBacked() && legacyModes) {
      const resolved = legacyModes.availableModes.find((mode) => mode.id === requested)?.id;
      if (!resolved) {
        if (modelChanged) { discardStaleEffort(); return; }
        throw new Error(`Unsupported thinking level: ${requested}`);
      }
      if (resolved === legacyModes.currentModeId) return;
      if (!await backend.setSessionMode(resolved)) throw new Error(`Failed to switch thinking level to ${resolved}`);
      legacyModes = { ...legacyModes, currentModeId: resolved };
      session.updateMetadata((metadata) => ({ ...metadata, currentOperatingModeCode: resolved, currentThoughtLevelCode: resolved }));
      return;
    }
    if (modelChanged) { discardStaleEffort(); return; }
    throw new Error(`This agent does not advertise thinking levels`);
  };

  const switchModelIfRequested = async (requestedModel: string): Promise<boolean> => {
    if (!requestedModel) {
      return false;
    }

    if (modelSelector) {
      const resolved = resolveRequestedCode(modelSelector.options, requestedModel);
      if (!resolved) {
        logger.debug(`[${opts.agentName}] Ignoring unknown ACP model request: ${requestedModel}`);
        return false;
      }
      if (resolved === modelSelector.currentCode) {
        return false;
      }
      const switched = await backend.setSessionConfigOption(modelSelector.configId, resolved);
      if (switched) {
        modelSelector.currentCode = resolved;
        return true;
      }
    }

    if (!legacyModels) {
      return false;
    }

    const resolvedLegacyModel = resolveRequestedLegacyModelCode(legacyModels, requestedModel);
    if (!resolvedLegacyModel) {
      logger.debug(`[${opts.agentName}] Ignoring unknown ACP legacy model request: ${requestedModel}`);
      return false;
    }
    if (resolvedLegacyModel === legacyModels.currentModelId) {
      return false;
    }

    const switched = await backend.setSessionModel(resolvedLegacyModel);
    if (switched) {
      legacyModels = {
        ...legacyModels,
        currentModelId: resolvedLegacyModel,
      };
      return true;
    }
    return false;
  };

  const isCurrentRequestedModel = (requested: string): boolean => {
    if (modelSelector) return resolveRequestedCode(modelSelector.options, requested) === modelSelector.currentCode;
    return !!legacyModels && resolveRequestedLegacyModelCode(legacyModels, requested) === legacyModels.currentModelId;
  };

  const onBackendMessage = (msg: AgentMessage) => {
    if (verbose) {
      logAcp('muted', `Outgoing raw backend message from ${opts.agentName}: ${formatUnknownForConsole(msg, ACP_RAW_PREVIEW_CHARS)}`);
    }

    if (msg.type === 'event' && msg.name === 'available_commands') {
      const commands = msg.payload as { name: string; description?: string }[];
      const commandNames = commands.map((c) => c.name);
      sawSlashCommands = commands.length > 0;
      if (verbose) {
        logAcp('muted', `Outgoing slash commands from ${opts.agentName} (${commands.length}):`);
        for (const command of commands) {
          logAcp('muted', `  /${command.name}${formatOptionalDetail(command.description, 160)}`);
        }
      }
      session.updateMetadata((currentMetadata) => ({
        ...currentMetadata,
        slashCommands: commandNames,
      }));
    }

    if (msg.type === 'event' && msg.name === 'config_options_update') {
      const configOptions = extractConfigOptionsFromPayload(msg.payload);
      if (configOptions) {
        if (verbose) {
          logAcp('muted', `Outgoing config options from ${opts.agentName} (${configOptions.length}):`);
          for (const option of configOptions) {
            if (option.type === 'select') {
              const optionValues = flattenSelectOptions(option.options);
              logAcp('muted', `  config=${option.id} category=${option.category ?? 'unknown'} current=${option.currentValue} options=${optionValues.length}`);
            } else {
              logAcp('muted', `  config=${option.id} type=${option.type} category=${option.category ?? 'unknown'}`);
            }
          }
        }

        modeSelector = extractConfigSelector(configOptions, 'mode');
        modelSelector = extractConfigSelector(configOptions, 'model');
        thoughtSelector = extractConfigSelector(configOptions, 'thought_level');
        if (verbose) {
          if (modeSelector) {
            sawModes = true;
            logAcp('muted', `Outgoing mode options from ${opts.agentName} (${modeSelector.options.length}), current=${modeSelector.currentCode}:`);
            for (const option of modeSelector.options) {
              logAcp('muted', `  mode=${option.code} label=${option.value}`);
            }
          } else {
            logAcp('muted', `Outgoing mode options from ${opts.agentName}: not reported in config options`);
          }
          if (modelSelector) {
            sawModels = true;
            logAcp('muted', `Outgoing model options from ${opts.agentName} (${modelSelector.options.length}), current=${modelSelector.currentCode}:`);
            for (const option of modelSelector.options) {
              logAcp('muted', `  model=${option.code} label=${option.value}`);
            }
          } else {
            logAcp('muted', `Outgoing model options from ${opts.agentName}: not reported in config options`);
          }
        }
        session.updateMetadata((currentMetadata) =>
          mergeAcpSessionConfigIntoMetadata(currentMetadata, { configOptions }),
        );
      }
    }

    if (msg.type === 'event' && msg.name === 'modes_update') {
      const modes = extractModeStateFromPayload(msg.payload);
      if (modes) {
        legacyModes = modes;
        sawModes = true;
        if (verbose) {
          logAcp('muted', `Outgoing modes from ${opts.agentName} (${modes.availableModes.length}), current=${modes.currentModeId}:`);
          for (const mode of modes.availableModes) {
            logAcp('muted', `  mode=${mode.id} name=${mode.name}${formatOptionalDetail(mode.description, 160)}`);
          }
        }
        session.updateMetadata((currentMetadata) =>
          mergeAcpSessionConfigIntoMetadata(currentMetadata, { modes }),
        );
      }
    }

    if (msg.type === 'event' && msg.name === 'models_update') {
      const models = extractModelStateFromPayload(msg.payload);
      if (models) {
        legacyModels = models;
        sawModels = true;
        if (verbose) {
          logAcp('muted', `Outgoing models from ${opts.agentName} (${models.availableModels.length}), current=${models.currentModelId}:`);
          for (const model of models.availableModels) {
            logAcp('muted', `  model=${model.modelId} name=${model.name}`);
          }
        }
        session.updateMetadata((currentMetadata) =>
          mergeAcpSessionConfigIntoMetadata(currentMetadata, { models }),
        );
      }
    }

    if (msg.type === 'event' && msg.name === 'current_mode_update') {
      const currentModeId = extractCurrentModeIdFromPayload(msg.payload);
      if (currentModeId) {
        if (modeSelector) {
          modeSelector = {
            ...modeSelector,
            currentCode: currentModeId,
          };
        }
        if (legacyModes) {
          legacyModes = {
            ...legacyModes,
            currentModeId,
          };
        }
        session.updateMetadata((currentMetadata) =>
          mergeAcpSessionConfigIntoMetadata(currentMetadata, { currentModeId }),
        );
      }
    }

    if (msg.type === 'status') {
      const suffix = msg.detail ? `: ${msg.detail}` : '';
      const statusLine = `Status: ${msg.status}${suffix}`;
      logAcp('muted', statusLine);
      // Deliberately NOT touching `thinking` here — see setThinking above.
      if (msg.status === 'idle') {
        clearPendingTurn();
      }
      if (msg.status === 'error' || msg.status === 'stopped') {
        if (msg.status === 'error') opts.onBackendError?.(msg.detail);
        stopRunnerFromBackendStatus(msg.status, msg.detail);
      }
    }

    const frontendMessage = formatAcpMessageForFrontend(opts.agentName, msg, verbose);
    if (frontendMessage) {
      logAcp(frontendMessage.kind, frontendMessage.text);
    }

    if (msg.type === 'token-count') {
      session.sendAgentUsageSnapshot(resolveSessionFlavor(opts.agentName), msg);
    }

    sendEnvelopes(sessionManager.mapMessage(msg));
  };

  backend.onMessage(onBackendMessage);

  // Same auto-title trigger as runClaude: the first user prompt of a
  // title-less session. The generator never overwrites a title the agent
  // already set through `change_title` (it re-checks `metadata.summary` before
  // writing), and it never sees assistant output — so pi-acp's startup banner
  // cannot become a title.
  const titleGenerator = new TitleGenerator(session);
  registerAgentAttachmentDownloads(session);
  let userMessageDelivery = Promise.resolve();
  session.onUserMessage((message) => {
    // Claim synchronously, then preserve message order while downloads finish.
    const downloads = session.drainAttachmentsForUserMessage();
    userMessageDelivery = userMessageDelivery.then(async () => {
      const attachments = await downloads;
      if (!message.content.text && !attachments?.length) {
        return;
      }
      titleGenerator.maybeGenerate(message.content.text);

      if (typeof message.meta?.permissionMode === 'string') {
        currentPermissionMode = message.meta.permissionMode;
        logger.debug(`[${opts.agentName}] Requested ACP permission mode: ${currentPermissionMode}`);
      }

      if (message.meta && Object.prototype.hasOwnProperty.call(message.meta, 'model')) {
        currentModel = message.meta.model ?? null;
        logger.debug(`[${opts.agentName}] Requested ACP model: ${currentModel ?? 'null'}`);
      }

      if (message.meta && Object.prototype.hasOwnProperty.call(message.meta, 'effort')) {
        currentEffort = message.meta.effort ?? null;
      }

      messageQueue.push(message.content.text, {
        permissionMode: currentPermissionMode,
        model: currentModel,
        effort: currentEffort,
      }, attachments, message.localKey);
    }).catch(() => {
      logger.warn('[ACP] Failed to prepare user attachments');
      session.sendSessionEvent({ type: 'message', message: 'Could not prepare this message. Please send it again.' });
    });
  });
  session.keepAlive(thinking, 'remote');

  const keepAliveInterval = setInterval(() => {
    session.keepAlive(thinking, 'remote');
  }, 2000);

  async function handleAbort() {
    try {
      if (acpSessionId) {
        await backend.cancel(acpSessionId);
      }
      permissionHandler.reset();
      abortController.abort();
    } catch (error) {
      logger.debug(`[${opts.agentName}] Abort failed:`, error);
    } finally {
      abortController = new AbortController();
    }
  }

  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  // The web picker calls this (instead of message meta) while the session is
  // working, because pi is presented with the Claude flavor. Only the
  // file-backed path can honour it; agents with an ACP selector switch via
  // message meta and never receive this RPC. Rejecting surfaces as an `{error}`
  // ack the web shows (rule 17) rather than a silently unapplied mode.
  session.rpcHandlerManager.registerHandler<{ mode?: unknown }, { mode: AcpPermissionMode }>(
    'set-permission-mode',
    async (request) => {
      if (!fileBackedModeActive) {
        throw new Error(`${opts.agentName} does not support live permission mode changes`);
      }
      const mode = typeof request?.mode === 'string' ? normalizeAcpPermissionMode(request.mode) : null;
      if (!mode) {
        throw new Error('Invalid permission mode');
      }
      if (!publishFileBackedPermissionMode(mode)) {
        throw new Error('Failed to write session mode file');
      }
      return { mode };
    },
  );
  registerKillSessionHandler(session.rpcHandlerManager, async () => {
    shouldExit = true;
    messageQueue.close();
    clearPendingTurn(new Error('Session terminated'));
    await handleAbort();
  }, session);

  try {
    const started = await backend.startSession();
    acpSessionId = started.sessionId;
    if (opts.model) {
      await switchModelIfRequested(opts.model);
      const applied = isCurrentRequestedModel(opts.model);
      if (!applied) session.sendSessionEvent({ type: 'message', message: 'The saved model is unavailable for this agent; using its current model.' });
    }
    session.updateMetadata((current) => ({
      ...current,
      attachmentKinds: opts.agentName === 'pi' && backend.supportsImageAttachments
        ? [...CLAUDE_ATTACHMENT_KINDS] : [],
    }));
    if (permissionModeIsFileBacked()) {
      fileBackedModeActive = true;
      publishFileBackedPermissionMode(initialPermissionMode);
    }
    if (verbose) {
      if (!sawSlashCommands) {
        logAcp('muted', `Outgoing slash commands from ${opts.agentName}: not reported yet`);
      }
      if (!sawModes) {
        logAcp('muted', `Outgoing modes from ${opts.agentName}: not reported yet`);
      }
      if (!sawModels) {
        logAcp('muted', `Outgoing models from ${opts.agentName}: not reported yet`);
      }
    }

    let todoDiscoverySent = false;
    while (!shouldExit) {
      const waitSignal = abortController.signal;
      const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
      if (!batch) {
        if (shouldExit) {
          break;
        }
        if (waitSignal.aborted) {
          continue;
        }
        break;
      }

      if (!acpSessionId) {
        throw new Error('ACP session is not started');
      }

      logAcp('incoming', `Incoming prompt: ${formatUnknownForConsole(batch.message, ACP_EVENT_PREVIEW_CHARS)}`);
      sendEnvelopes(sessionManager.startTurn());
      setThinking(true);
      const turnEnded = waitForTurnEnd();
      try {
        if (typeof batch.mode.permissionMode === 'string' && batch.mode.permissionMode.length > 0) {
          await switchPermissionModeIfRequested(batch.mode.permissionMode);
        }
        const modelChanged = typeof batch.mode.model === 'string' && batch.mode.model.length > 0
          ? await switchModelIfRequested(batch.mode.model) : false;
        if (typeof batch.mode.effort === 'string') {
          await switchEffortIfRequested(batch.mode.effort, modelChanged);
        }
        const prompt = todoDiscoverySent ? batch.message : `${batch.message}\n\n${BUILTIN_TODO_DISCOVERY}`;
        const attachments = batch.attachments ?? [];
        const staged = attachments.length ? await stageClaudeAttachments(attachments, {
          happyHomeDir: configuration.happyHomeDir, sessionId: session.sessionId,
        }) : [];
        await backend.sendPrompt(acpSessionId, appendStagedAttachmentsToPrompt(prompt, staged), attachments);
        todoDiscoverySent = true;
        await turnEnded;
        sendEnvelopes(sessionManager.endTurn('completed'));
        // Sweep AFTER the turn's envelopes are queued: `turn-end` starts the
        // web's 1.5s countdown for unclaimed drafts.
        streamRelay.endTurn();
        // Release the lease only after the turn's last envelopes are queued, so
        // the web folds a turn that already holds its final answer.
        setThinking(false);
        session.sendSessionEvent({ type: 'ready' });
        if (verbose) {
          logAcp('muted', `Outgoing prompt completion from ${opts.agentName}`);
        }
      } catch (error) {
        session.sendSessionEvent({ type: 'message', message: 'The agent could not process this message or its attachments. Please check the agent and try again.' });
        sendEnvelopes(sessionManager.endTurn('failed'));
        streamRelay.endTurn();
        setThinking(false);
        session.sendSessionEvent({ type: 'ready' });
        logAcp('error', `Prompt error from ${opts.agentName}: ${error instanceof Error ? error.message : String(error)}`);
        clearPendingTurn(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    }
  } finally {
    // A turn cut short by kill/backend death never reached setThinking(false)
    // above; release the lease before the interval stops re-sending it.
    setThinking(false);
    clearInterval(keepAliveInterval);
    // A turn cut short (kill, backend death) never reached endTurn above;
    // sweep so the web does not keep a half-answer on screen for 5 minutes.
    // Idempotent: a normally ended turn makes this a no-op.
    streamRelay.endTurn();
    streamRelay.dispose();
    reconnectionHandle?.cancel();
    clearPendingTurn(new Error('ACP runner shutting down'));

    try {
      permissionHandler.reset();
    } catch (error) {
      logger.debug(`[${opts.agentName}] Failed to reset permission handler:`, error);
    }

    backend.offMessage?.(onBackendMessage);
    await backend.dispose();

    if (fileBackedPermissionMode) {
      try {
        removeSessionModeFile(session.sessionId);
      } catch (error) {
        logger.debug(`[${opts.agentName}] Failed to remove session mode file:`, error);
      }
    }

    try {
      happyServer.stop();
    } catch (error) {
      logger.debug(`[${opts.agentName}] Failed to stop Happy MCP server:`, error);
    }

    try {
      session.updateMetadata((currentMetadata) => ({
        ...currentMetadata,
        lifecycleState: 'archived',
        lifecycleStateSince: Date.now(),
        archivedBy: 'cli',
        archiveReason: 'Session ended',
      }));
      session.sendSessionDeath();
      await session.flush();
      await session.close();
    } catch (error) {
      logger.debug(`[${opts.agentName}] Session close failed:`, error);
    }
  }
}
