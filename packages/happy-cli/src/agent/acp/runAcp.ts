import { BUILTIN_TODO_DISCOVERY } from '@/modules/todo/skill';
import { readPiModelsJson, resolvePiContextUsage, type PiContextReport } from './piContextUsage';
import { buildAcpPrompt, routeAcpUserText } from './acpSlashCommand';
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
import { acpNoticeMessage, type AcpNotice } from './acpNotices';
import { describeAcpTurnFailure } from './acpTurnFailure';
import { DefaultTransport } from '@/agent/transport';
import { AcpSessionManager } from './AcpSessionManager';
import { PI_STEER_CAPABILITY, PROMPT_QUEUE_CAPABILITY, PROJECT_SESSION_CAPABILITY, type SessionEnvelope } from '@slopus/happy-wire';
import { createProjectInjector } from '@/projects/injector';
import { sharedProjectsClient } from '@/projects/client';
import { logger } from '@/ui/logger';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { Credentials, readSettings } from '@/persistence';
import { getInitialMachineMetadata } from '@/daemon/machineMetadata';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { createSessionForStartup } from '@/utils/startupSessionCreate';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { encodeBase64, decodeBase64 } from '@/api/encryption';
import type { Session as ApiSession } from '@/api/types';
import { claimSessionOrExit } from '@/utils/sessionLock';
import { applyServerSnapshot, mergeReconnectMetadata, withoutServerSnapshot } from '@/utils/reconnectSession';
import { piRestartNotice, readAcpReconnectEnv } from './acpSessionResume';
import { OUT_OF_TURN_QUIET_MS, outOfTurnAction } from './acpOutOfTurn';
import { createPiSteerChannel } from './piSteerChannel';
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
import { EditReportThrottle, extractAcpEditPaths } from '@/sessions/editPaths';
import { reportSessionEditToDaemon } from '@/daemon/controlClient';
import { readGeminiConfiguredModel } from './geminiConfiguredModel';

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

/** B-632: how long a steer waits for the pi extension's long poll to take it. */
const PI_STEER_OFFER_TIMEOUT_MS = 5_000;

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
  /**
   * B-633: the agent session to reopen (`session/load`) — the daemon's resume
   * of a pi session passes its `piSessionId` with HAPPY_RECONNECT_* so the
   * same Happy session row continues.
   */
  resumeAgentSessionId?: string;
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
    metadata: getInitialMachineMetadata(),
  });

  const { state, metadata } = createSessionMetadata({
    flavor: resolveSessionFlavor(opts.agentName),
    ...(process.env.VH_TEAM_OPERATION_ID ? { teamOperationId: process.env.VH_TEAM_OPERATION_ID } : {}),
    machineId: settings.machineId,
    startedBy: opts.startedBy,
    sandbox: settings.sandboxConfig,
    capabilities: [PROMPT_QUEUE_CAPABILITY, PROJECT_SESSION_CAPABILITY],
  });
  metadata.attachmentKinds = [];
  // B-844: report the model the machine's Gemini config pins (null = none),
  // so the web's "follow latest" leaves it alone.
  if (opts.agentName === 'gemini') metadata.configuredModel = readGeminiConfiguredModel();
  // B-633: the daemon's resume reattaches to the SAME session row (same as
  // runCodex / runClaude): no new session, the server snapshot seeds the cursor.
  const reconnect = readAcpReconnectEnv(process.env);
  let response: ApiSession | null;
  if (reconnect) {
    logger.debug(`[acp] Reconnecting to existing session ${reconnect.sessionId}`);
    response = {
      id: reconnect.sessionId,
      seq: reconnect.seq,
      encryptionKey: decodeBase64(reconnect.encryptionKey),
      encryptionVariant: reconnect.encryptionVariant,
      metadata,
      metadataVersion: reconnect.metadataVersion,
      agentState: state,
      agentStateVersion: reconnect.agentStateVersion,
    };
  } else {
    // B-689: daemon spawns never run on an offline stub (see startupSessionCreate).
    response = await createSessionForStartup(() => api.getOrCreateSession({ tag: sessionTag, metadata, state }), { startedBy: opts.startedBy, log: (m) => logger.debug(m) });
  }
  if (response) {
    logAcp('muted', `Happy Session ID: ${response.id}`);
    // AGENTS rule 20: one live wrapper per session; a resume takes over.
    await claimSessionOrExit(response.id, { takeover: !!reconnect, flavor: resolveSessionFlavor(opts.agentName) });
  }
  if (reconnect && response && !await api.reactivateSession(response.id)) {
    throw new Error(`Failed to reactivate archived session ${response.id}`);
  }
  let reconnectSeeded = false;
  // B-633: a resumed session keeps the permission mode it published (a resume
  // without --permission-mode used to fall back to `default`, stopping the first
  // turn at an approval the session had never asked for).
  let resumedPermissionMode: AcpPermissionMode | null = null;
  if (reconnect && response) {
    const snapshot = await api.getSession(response.id, response.encryptionKey, response.encryptionVariant);
    if (snapshot.ok) {
      response = applyServerSnapshot(response, snapshot.session);
      reconnectSeeded = true;
      resumedPermissionMode = normalizeAcpPermissionMode(snapshot.session.metadata?.permissionMode) ?? null;
    } else {
      response = withoutServerSnapshot(response);
      logger.debug(`[acp] Reconnect without server snapshot (${snapshot.reason}); skipping existing messages`);
    }
  }

  let session: ApiSessionClient;
  let permissionHandler: GenericAcpPermissionHandler;
  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    sessionClientOptions: reconnectSeeded && response ? { initialSeq: response.seq } : undefined,
    onSessionSwap: (newSession) => {
      session = newSession;
      if (permissionHandler) {
        permissionHandler.updateSession(newSession);
      }
      attachPromptQueueDrain(newSession);
    },
  });
  session = initialSession;
  if (reconnect) {
    session.suppressNextArchiveSignal();
    if (!reconnectSeeded) session.skipExistingMessages();
    void session.cancelUndeliveredQueuedInputs();
    session.updateMetadata((meta) => mergeReconnectMetadata(meta, metadata, Date.now()));
  }

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
  // B-509: server-side prompt queue — one item per turn, only while idle.
  // Re-attached on every session-client swap (offline reconnection).
  function attachPromptQueueDrain(client: ApiSessionClient) {
    const drain = client.attachPromptQueueDrain({
      isIdle: () => messageQueue.size() === 0 && messageQueue.isWaiting(),
    });
    messageQueue.setOnWait(() => drain.onIdle());
  }
  attachPromptQueueDrain(session);
  let currentPermissionMode: string | undefined;
  let currentModel: string | null | undefined;
  let modeSelector: AcpConfigSelector | null = null;
  let modelSelector: AcpConfigSelector | null = null;
  let thoughtSelector: AcpConfigSelector | null = null;
  let currentEffort: string | null | undefined;
  let legacyModes: SessionModeState | null = null;
  let legacyModels: SessionModelState | null = null;
  let sawSlashCommands = false;
  /** The agent's own commands (`available_commands_update`); null until it lists them. */
  let agentCommands: string[] | null = null;
  let sawModes = false;
  let sawModels = false;

  // Mode for agents without an ACP mode selector (pi). The gate on the agent
  // side reads it from the session mode file; the web reads it from metadata
  // (rule 14: publish what is in effect, not the intent).
  const initialPermissionMode: AcpPermissionMode = opts.permissionMode ?? resumedPermissionMode ?? 'default';
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
  // B-632 ①: steer into a running pi turn through the Very Happy pi extension.
  const piSteer = opts.agentName === 'pi' ? createPiSteerChannel() : null;
  piSteer?.onReady(() => {
    logger.debug(`[${opts.agentName}] pi extension connected to the steer channel`);
    session.updateMetadata((current) => ({ ...current, capabilities: [...new Set([...(current.capabilities ?? []), PI_STEER_CAPABILITY])] }));
  });
  const happyServer = await startHappyServer(session, {
    assistant: isAssistantVariant,
    ...(piSteer ? { piSteer } : {}),
    push: { sendAttention: (input) => api.push().sendAttention(input) },
    // B-727: pi's report is resolved against models.json (pi's 128k default ≠ a configured window).
    ...(opts.agentName === 'pi' ? { onContextUsage: (report: PiContextReport) => {
      const modelsJson = readPiModelsJson();
      session.updateAgentState(state => ({ ...state, contextUsage: resolvePiContextUsage(report, modelsJson, state.contextUsage, Date.now()) }));
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
  const createBackend = () => new AcpBackend({
    agentName: opts.agentName,
    cwd: process.cwd(),
    command: opts.command,
    args: opts.args,
    env: {
      ...teamsPiEnv,
      HAPPY_MCP_URL: happyServer.url,
      ...(happyServer.contextUsageUrl ? { HAPPY_CONTEXT_USAGE_URL: happyServer.contextUsageUrl } : {}),
      ...(happyServer.steerUrl ? { HAPPY_PI_STEER_URL: happyServer.steerUrl } : {}),
      HAPPY_SESSION_ID: session.sessionId,
      // B-497: sender identity for `very-happy sessions message|peers` in this shell.
      VH_PEER_SESSION_ID: session.sessionId,
      HAPPY_PERMISSION_MODE: initialPermissionMode,
    },
    mcpServers,
    permissionHandler,
    transportHandler: new DefaultTransport(opts.agentName),
    verbose,
  });
  // B-629: `let` — the agent process can die mid-session, and the next message starts a new one.
  let backend = createBackend();

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
  /** B-632 ③: armed while a synthetic (out-of-turn) turn is open; its expiry ends it. */
  let outOfTurnTimer: NodeJS.Timeout | null = null;
  const endOutOfTurn = (reason: string) => {
    if (!outOfTurnTimer) return;
    clearTimeout(outOfTurnTimer);
    outOfTurnTimer = null;
    logger.debug(`[${opts.agentName}] Out-of-turn output ended (${reason})`);
    sendEnvelopes(sessionManager.endTurn('completed'));
    setThinking(false);
  };
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
  let turnCancelled = false;
  // B-629: before the agent's first session is up, a terminal status ends the runner (the
  // agent could not be started at all); after that the session outlives the agent process
  // (Orca, src/main/acp/acp-structured-session-adapter.ts): a death ends the turn in
  // flight with its reason and the next message starts a fresh agent process.
  let backendStarted = false;
  let backendGone: Error | null = null;
  let todoDiscoverySent = false;
  // B-645: project prefix / digest on the prompt; reset with todoDiscoverySent when a fresh agent forgets the conversation.
  const projectInjector = createProjectInjector({ client: sharedProjectsClient(), sessionId: () => session?.sessionId, metadata: () => (session?.getMetadata?.() ?? null) as Record<string, any> | null, agent: opts.agentName });

  const stopRunnerFromBackendStatus = (status: 'error' | 'stopped', detail?: string) => {
    const reason = detail
      ? `${opts.agentName} backend ${status}: ${detail}`
      : `${opts.agentName} backend ${status}`;
    logger.debug(`[${opts.agentName}] ${reason}; stopping ACP runner`);
    shouldExit = true;
    messageQueue.close();
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

  const editThrottle = new EditReportThrottle();
  const onBackendMessage = (msg: AgentMessage) => {
    if (verbose) {
      logAcp('muted', `Outgoing raw backend message from ${opts.agentName}: ${formatUnknownForConsole(msg, ACP_RAW_PREVIEW_CHARS)}`);
    }

    if (msg.type === 'event' && msg.name === 'available_commands') {
      const commands = msg.payload as { name: string; description?: string }[];
      const commandNames = commands.map((c) => c.name);
      sawSlashCommands = commands.length > 0;
      agentCommands = commandNames;
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
      if (msg.status === 'error' || msg.status === 'stopped') {
        if (msg.status === 'error') opts.onBackendError?.(msg.detail);
        if (!backendStarted) {
          stopRunnerFromBackendStatus(msg.status, msg.detail);
        } else if (msg.status === 'stopped') {
          // B-629: the agent process died. A turn in flight ends through its own
          // rejection (AcpBackend races the prompt against the exit); the next
          // message restarts the agent. A mid-session `error` is that prompt's own
          // failure and is reported once, by the loop's catch.
          backendGone = new Error(msg.detail ?? `${opts.agentName} process exited`);
        }
      }
    }

    if (msg.type === 'event' && msg.name === 'notice') {
      // B-629: pi's own retry / compaction / notify lines (acpNotices.ts) are service
      // lines, never part of the answer.
      const message = acpNoticeMessage(opts.agentName, msg.payload as AcpNotice);
      logAcp('muted', message);
      session.sendSessionEvent({ type: 'message', message });
      return;
    }

    const frontendMessage = formatAcpMessageForFrontend(opts.agentName, msg, verbose);
    if (frontendMessage) {
      logAcp(frontendMessage.kind, frontendMessage.text);
    }

    if (msg.type === 'token-count') {
      session.sendAgentUsageSnapshot(resolveSessionFlavor(opts.agentName), msg);
    }

    if (msg.type === 'tool-call') {
      // B-497: pi write/edit (and any ACP edit-kind call) feeds the daemon's conflict table.
      for (const edit of editThrottle.take(extractAcpEditPaths(msg.toolName, msg.args))) {
        reportSessionEditToDaemon({ sessionId: session.sessionId, path: edit.path, tool: edit.tool, cwd: process.cwd() });
      }
    }

    // B-632 ③: agent output with no prompt of ours running gets a turn of its own.
    const action = outOfTurnAction(msg, { open: outOfTurnTimer !== null, inPromptTurn: thinking && outOfTurnTimer === null, backendStarted });
    if (action === 'start') {
      sendEnvelopes(sessionManager.startTurn());
      setThinking(true);
    }
    if (action === 'start' || action === 'touch') {
      if (outOfTurnTimer) clearTimeout(outOfTurnTimer);
      outOfTurnTimer = setTimeout(() => endOutOfTurn('quiet'), OUT_OF_TURN_QUIET_MS);
      outOfTurnTimer.unref?.();
    }

    sendEnvelopes(sessionManager.mapMessage(msg));

    if (action === 'end') endOutOfTurn('idle');
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

      // Owner 10-30: a standalone `/compact` runs as a turn of its own — never steered
      // into a running turn or joined with queued messages, where the agent reads it
      // as chat — and an agent without compaction gets Very Happy's answer, not the model's.
      const route = routeAcpUserText(message.content.text, agentCommands);
      if (route.kind === 'unsupported') {
        session.sendSessionEvent({ type: 'message', message: route.notice });
        return;
      }
      if (route.kind === 'command') {
        messageQueue.pushIsolate(route.text, {
          permissionMode: currentPermissionMode,
          model: currentModel,
          effort: currentEffort,
        }, attachments, message.localKey);
        return;
      }

      // B-632 ①: 「Steer」 on a queued message — into the running pi turn when the
      // extension takes it; otherwise (nothing running, no extension, attachments,
      // not taken in time) it is queued as the next turn exactly as before.
      if (message.meta?.delivery === 'steer' && piSteer?.ready && thinking && !attachments?.length) {
        if (await piSteer.offer(message.content.text, PI_STEER_OFFER_TIMEOUT_MS)) {
          logger.debug(`[${opts.agentName}] User message steered into the running turn`);
          return;
        }
        logger.debug(`[${opts.agentName}] Steer not taken; queued for the next turn`);
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

  // B-629: set around `sendPrompt` only, so a Stop pressed while the agent is being
  // restarted does not mark the turn that then runs in full as cancelled.
  let promptInFlight = false;
  async function handleAbort() {
    turnCancelled = thinking && promptInFlight;
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
  const disposeTermination = registerKillSessionHandler(session.rpcHandlerManager, async () => {
    shouldExit = true;
    messageQueue.close();
    await handleAbort();
  }, session, { processSignals: true });

  // B-629: a fresh agent process after the previous one died. The session (and its
  // transcript on the server) is kept; the agent itself starts without memory, and the
  // session says so — pi-acp has no resume for us yet (follow-up).
  // What a freshly started agent session needs before its first prompt: the saved or
  // web-chosen model, the attachment kinds it accepts, the file-backed permission mode.
  const afterSessionStarted = async (requestedModel: string | null | undefined) => {
    if (requestedModel) {
      await switchModelIfRequested(requestedModel);
      const applied = isCurrentRequestedModel(requestedModel);
      if (!applied) session.sendSessionEvent({ type: 'message', message: 'The saved model is unavailable for this agent; using its current model.' });
    }
    session.updateMetadata((current) => ({
      ...current,
      attachmentKinds: opts.agentName === 'pi' && backend.supportsImageAttachments
        ? [...CLAUDE_ATTACHMENT_KINDS] : [],
    }));
    if (permissionModeIsFileBacked()) {
      fileBackedModeActive = true;
      publishFileBackedPermissionMode(fileBackedPermissionMode ?? initialPermissionMode);
    }
  };

  // B-633: the agent's own session id, kept in metadata (`piSessionId`) so the
  // next wrapper (daemon resume) or the next agent process can reopen it.
  let agentSessionId: string | null = opts.resumeAgentSessionId ?? null;
  const rememberAgentSession = (id: string | undefined) => {
    if (!id || opts.agentName !== 'pi') return;
    agentSessionId = id;
    session.updateMetadata((current) => current.piSessionId === id ? current : { ...current, piSessionId: id });
  };

  const restartBackend = async () => {
    const gone = backendGone;
    backend.offMessage?.(onBackendMessage);
    // No session until the new agent has one: a failed restart must not leave the old id
    // behind to be prompted (every later turn would fail with "Session not started").
    acpSessionId = null;
    try { await backend.dispose(); } catch (error) { logger.debug(`[${opts.agentName}] dispose of the dead backend failed:`, error); }
    backend = createBackend();
    backend.onMessage(onBackendMessage);
    // B-633: reopen the conversation the dead agent had (pi-acp `session/load`).
    const started = await backend.startSession(undefined, agentSessionId ? { loadSessionId: agentSessionId } : {});
    acpSessionId = started.sessionId;
    rememberAgentSession(started.agentSessionId);
    // Only now is the death dealt with; a restart that threw above keeps `backendGone`,
    // so the next message tries again instead of prompting nothing.
    backendGone = null;
    todoDiscoverySent = false;
    projectInjector.reset();
    await afterSessionStarted(currentModel ?? opts.model);
    logger.debug(`[${opts.agentName}] Restarted the agent after it exited: ${gone?.message ?? 'unknown'} (conversation: ${started.resumed ?? 'new'}${started.loadFailure ? `, ${started.loadFailure}` : ''})`);
    session.sendSessionEvent({ type: 'message', message: piRestartNotice(opts.agentName, 'agent-exit', started) });
  };

  try {
    const resumeId = opts.resumeAgentSessionId;
    const started = await backend.startSession(undefined, resumeId ? { loadSessionId: resumeId } : {});
    acpSessionId = started.sessionId;
    rememberAgentSession(started.agentSessionId);
    backendStarted = true;
    await afterSessionStarted(opts.model);
    if (resumeId) {
      logger.debug(`[${opts.agentName}] Resume of agent session ${resumeId}: ${started.resumed ?? 'new'}${started.loadFailure ? ` (${started.loadFailure})` : ''}`);
      if (started.resumed !== 'loaded') session.sendSessionEvent({ type: 'message', message: piRestartNotice(opts.agentName, 'resume', started) });
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

      logAcp('incoming', `Incoming prompt: ${formatUnknownForConsole(batch.message, ACP_EVENT_PREVIEW_CHARS)}`);
      // A synthetic turn still open (agent output that came by itself) ends before ours.
      endOutOfTurn('prompt');
      sendEnvelopes(sessionManager.startTurn());
      turnCancelled = false;
      setThinking(true);
      try {
        if (backendGone) {
          await restartBackend();
        }
        if (!acpSessionId) {
          throw new Error('ACP session is not started');
        }
        if (typeof batch.mode.permissionMode === 'string' && batch.mode.permissionMode.length > 0) {
          await switchPermissionModeIfRequested(batch.mode.permissionMode);
        }
        const modelChanged = typeof batch.mode.model === 'string' && batch.mode.model.length > 0
          ? await switchModelIfRequested(batch.mode.model) : false;
        if (typeof batch.mode.effort === 'string') {
          await switchEffortIfRequested(batch.mode.effort, modelChanged);
        }
        // B-727: a slash command (`/compact`, `/name x`…) is executed by the ACP agent only when the
        // prompt still starts with it — a project prefix or the todo note turned pi's /compact into
        // a chat message the model answered with a summary, and nothing was compacted.
        const { prompt, slashCommand } = await buildAcpPrompt(batch.message, {
          todoNoteSent: todoDiscoverySent, todoNote: BUILTIN_TODO_DISCOVERY, decorate: (m) => projectInjector.decorate(m),
        });
        const attachments = batch.attachments ?? [];
        const staged = attachments.length ? await stageClaudeAttachments(attachments, {
          happyHomeDir: configuration.happyHomeDir, sessionId: session.sessionId,
        }) : [];
        // B-629: the turn is over when the prompt is answered (ACP sends every update
        // before its response); no idle heuristic, no deadline (Orca: none either).
        promptInFlight = true;
        let outcome: Awaited<ReturnType<typeof backend.sendPrompt>>;
        try {
          outcome = await backend.sendPrompt(acpSessionId, appendStagedAttachmentsToPrompt(prompt, staged), attachments);
        } finally {
          promptInFlight = false;
        }
        if (!slashCommand) todoDiscoverySent = true;
        const stopReason = outcome && typeof outcome === 'object' ? outcome.stopReason : undefined;
        if (stopReason === 'error') {
          // pi-acp 0.0.33 answers a turn pi's provider failed with `stopReason: "error"` and
          // no text at all; that is a failed turn, not a finished one.
          throw new Error('the turn ended with an error reported by the agent');
        }
        const cancelled = turnCancelled || stopReason === 'cancelled';
        sendEnvelopes(sessionManager.endTurn(cancelled ? 'cancelled' : 'completed'));
        if (!cancelled && stopReason && stopReason !== 'end_turn') {
          // `max_tokens` / `refusal`: the agent stopped short and said why.
          session.sendSessionEvent({ type: 'message', message: `${opts.agentName} stopped the turn: ${stopReason}` });
        }
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
        // B-629: a failed turn is this turn's failure, not the session's (Orca: a rejected
        // send). Say what the agent said; keep the session; the next message runs anew.
        const failure = describeAcpTurnFailure(opts.agentName, error);
        session.sendSessionEvent({ type: 'message', message: failure.message });
        sendEnvelopes(sessionManager.endTurn('failed'));
        streamRelay.endTurn();
        setThinking(false);
        session.sendSessionEvent({ type: 'ready' });
        logAcp('error', `Prompt error from ${opts.agentName}: ${error instanceof Error ? error.message : String(error)}`);
        if (failure.exited && error instanceof Error) {
          backendGone = error;
        }
      }
    }
  } finally {
    disposeTermination?.();
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
      session.closePromptQueueDrain(); // B-509: no more pops into a process that is leaving
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
