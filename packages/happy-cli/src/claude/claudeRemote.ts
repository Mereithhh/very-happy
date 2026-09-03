import { EnhancedMode } from "./loop";
import { query, type QueryOptions, type SDKMessage, type SDKResultMessage, type SDKSystemMessage, AbortError, SDKUserMessage } from '@/claude/sdk'
import type { MessageParam } from '@anthropic-ai/sdk/resources'
import { mapToClaudeMode } from "./utils/permissionMode";
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { join } from 'node:path';
import { parseSpecialCommand } from "@/parsers/specialCommands";
import { logger } from "@/lib";
import { QUERY_RECYCLE_NOTICE, queryRecycleReason } from './utils/remoteQueryRecycle';
import { PushableAsyncIterable } from "@/utils/PushableAsyncIterable";
import { getProjectPath } from "./utils/path";
import { awaitFileExist } from "@/modules/watcher/awaitFileExist";
import { systemPrompt } from "./utils/systemPrompt";
import type { CanUseTool, OnElicitation, OnUserDialog, PermissionResult } from "./sdk/types";
import type { JsRuntime } from "./runClaude";
import { contentLogMetadata } from '@/utils/contentLogMetadata';
import type { ClaudeSdkMetadata } from './claudeSdkMetadata';
import { modelSwitchFailureNotice, modelTarget, needsModelSwitch } from './claudeLiveModel';

export async function claudeRemote(opts: {

    // Fixed parameters
    sessionId: string | null,
    path: string,
    mcpServers?: Record<string, any>,
    claudeEnvVars?: Record<string, string>,
    claudeArgs?: string[],
    allowedTools: string[],
    additionalDirectories?: string[],
    signal?: AbortSignal,
    canCallTool: (toolName: string, input: unknown, mode: EnhancedMode, options: Parameters<CanUseTool>[2]) => Promise<PermissionResult>,
    onElicitation?: OnElicitation,
    onUserDialog?: OnUserDialog,
    /** Called when the Query object is ready — exposes live query controls. */
    onQueryReady?: (query: {
        setPermissionMode: (mode: string) => Promise<void>;
        /** Live model switch; rejects on an alias Claude Code does not know. */
        setModel: (model?: string) => Promise<void>;
        interrupt: () => Promise<void>;
        steer: (message: MessageParam['content'], mode: EnhancedMode) => void;
    }) => void,
    /** Path to temporary settings file with SessionStart hook (required for session tracking) */
    hookSettingsPath: string,
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    jsRuntime?: JsRuntime,

    // Dynamic parameters
    nextMessage: () => Promise<{ message: MessageParam['content'], mode: EnhancedMode } | null>,
    onReady: (result?: SDKResultMessage) => void,
    isAborted: (toolCallId: string) => boolean,

    // Callbacks
    onSessionFound: (id: string) => void,
    onThinkingChange?: (thinking: boolean) => void,
    onMessage: (message: SDKMessage) => void,
    onCompletionEvent?: (message: string) => void,
    /** B-276: the turn ended with an auth failure that poisons this Query. */
    onAuthFailure?: (reason: string) => void,
    onSessionReset?: () => void,
    onSDKMetadata?: (metadata: ClaudeSdkMetadata) => void
}) {

    // Check if session is valid
    let startFrom = opts.sessionId;
    if (opts.sessionId && !claudeCheckSession(opts.sessionId, opts.path)) {
        startFrom = null;
    }
    
    // Extract --resume from claudeArgs if present (for first spawn)
    if (!startFrom && opts.claudeArgs) {
        for (let i = 0; i < opts.claudeArgs.length; i++) {
            if (opts.claudeArgs[i] === '--resume') {
                // Check if next arg exists and looks like a session ID
                if (i + 1 < opts.claudeArgs.length) {
                    const nextArg = opts.claudeArgs[i + 1];
                    // If next arg doesn't start with dash and contains dashes, it's likely a UUID
                    if (!nextArg.startsWith('-') && nextArg.includes('-')) {
                        startFrom = nextArg;
                        logger.debug(`[claudeRemote] Found --resume with session ID: ${startFrom}`);
                        break;
                    } else {
                        // Just --resume without UUID - SDK doesn't support this
                        logger.debug('[claudeRemote] Found --resume without session ID - not supported in remote mode');
                        break;
                    }
                } else {
                    // --resume at end of args - SDK doesn't support this
                    logger.debug('[claudeRemote] Found --resume without session ID - not supported in remote mode');
                    break;
                }
            }
        }
    }

    // Set environment variables for Claude Code SDK
    if (opts.claudeEnvVars) {
        Object.entries(opts.claudeEnvVars).forEach(([key, value]) => {
            process.env[key] = value;
        });
    }

    // Get initial message
    const initial = await opts.nextMessage();
    if (!initial) { // No initial message - exit
        return;
    }

    // Handle special commands (extract text for parsing when content is a block array)
    const initialText = typeof initial.message === 'string'
        ? initial.message
        : (initial.message.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined)?.text ?? '';
    const specialCommand = parseSpecialCommand(initialText);

    // Handle /clear command
    if (specialCommand.type === 'clear') {
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Context was reset');
        }
        if (opts.onSessionReset) {
            opts.onSessionReset();
        }
        opts.onReady();
        return;
    }

    // Handle /compact command
    let isCompactCommand = false;
    if (specialCommand.type === 'compact') {
        logger.debug('[claudeRemote] /compact command detected - will process as normal but with compaction behavior');
        isCompactCommand = true;
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Compaction started');
        }
    }

    // Prepare SDK options
    let mode = initial.mode;
    const sdkOptions: QueryOptions = {
        cwd: opts.path,
        resume: startFrom ?? undefined,
        mcpServers: opts.mcpServers,
        permissionMode: mapToClaudeMode(initial.mode.permissionMode),
        // This is only the SDK safety opt-in; permissionMode/canUseTool still
        // enforce the selected policy. It must be enabled at Query creation so
        // a later explicit live switch to bypassPermissions can succeed.
        allowDangerouslySkipPermissions: true,
        model: initial.mode.model,
        fallbackModel: initial.mode.fallbackModel,
        customSystemPrompt: initial.mode.customSystemPrompt ? initial.mode.customSystemPrompt + '\n\n' + systemPrompt : undefined,
        appendSystemPrompt: initial.mode.appendSystemPrompt ? initial.mode.appendSystemPrompt + '\n\n' + systemPrompt : systemPrompt,
        allowedTools: initial.mode.allowedTools ? initial.mode.allowedTools.concat(opts.allowedTools) : opts.allowedTools,
        additionalDirectories: opts.additionalDirectories,
        disallowedTools: initial.mode.disallowedTools,
        effort: initial.mode.effort,
        canCallTool: (toolName, input, options) => opts.canCallTool(toolName, input, mode, options),
        onElicitation: opts.onElicitation,
        onUserDialog: opts.onUserDialog,
        supportedDialogKinds: opts.onUserDialog ? ['refusal_fallback_prompt'] : undefined,
        abort: opts.signal,
        settingsPath: opts.hookSettingsPath,
    }

    // Track thinking state
    let thinking = false;
    const updateThinking = (newThinking: boolean) => {
        if (thinking !== newThinking) {
            thinking = newThinking;
            logger.debug(`[claudeRemote] Thinking state changed to: ${thinking}`);
            if (opts.onThinkingChange) {
                opts.onThinkingChange(thinking);
            }
        }
    };

    // Push initial message
    let messages = new PushableAsyncIterable<SDKUserMessage>();
    messages.push({
        type: 'user',
        parent_tool_use_id: null,
        origin: { kind: 'human' },
        message: {
            role: 'user',
            content: initial.message,
        },
    });

    // Start the loop
    const response = query({
        prompt: messages,
        options: sdkOptions,
    });

    // Expose query control methods to permission handler
    if (opts.onQueryReady) {
        opts.onQueryReady({
            setPermissionMode: (mode: string) => response.setPermissionMode(mode as any),
            setModel: (model?: string) => response.setModel(modelTarget(model)),
            interrupt: async () => { await response.interrupt(); },
            steer: (message, nextMode) => {
                // Steer injects into the CURRENT turn, and a model cannot change
                // mid-turn — keep the one that is actually running so the next
                // turn boundary still sees (and applies) the difference.
                mode = { ...nextMode, model: mode.model };
                messages.push({
                    type: 'user',
                    parent_tool_use_id: null,
                    priority: 'now',
                    origin: { kind: 'human' },
                    message: { role: 'user', content: message },
                });
            },
        });
    }

    // `error` of the latest flagged assistant frame in the current turn — the
    // typed signal for deciding whether this Query is still usable (see
    // utils/remoteQueryRecycle.ts). Reset when the turn's result is handled.
    let lastAssistantError: string | undefined;

    updateThinking(true);
    try {
        logger.debug(`[claudeRemote] Starting to iterate over response`);

        for await (const message of response) {
            logger.debug(`[claudeRemote] Message ${message.type}`, contentLogMetadata(message));

            if (message.type === 'assistant' && message.error) {
                lastAssistantError = message.error;
            }

            // Handle messages. During /compact, Claude emits the generated
            // summary as a normal assistant text message before the result.
            // Mark it so downstream UI/protocol mapping can treat it as
            // housekeeping instead of a real assistant response.
            const outboundMessage = isCompactCommand && message.type === 'assistant'
                ? { ...message, isCompactSummary: true } as SDKMessage
                : message;
            opts.onMessage(outboundMessage);

            // Handle special system messages
            if (message.type === 'system' && message.subtype === 'init') {
                // Start thinking when session initializes
                updateThinking(true);

                const systemInit = message as SDKSystemMessage;

                // Session id is still in memory, wait until session file is written to disk
                // Start a watcher for to detect the session id
                // Emit SDK metadata (tools, slash commands) from init message
                if (opts.onSDKMetadata) {
                    opts.onSDKMetadata({
                        tools: systemInit.tools,
                        slashCommands: systemInit.slash_commands,
                        mcpServers: systemInit.mcp_servers?.map(s => ({ name: s.name, status: s.status })),
                        skills: systemInit.skills,
                        model: systemInit.model,
                        // `mode`, not `initial.mode`: the model can move mid-Query
                        // via setModel, and init is re-emitted every turn with the
                        // model actually in force.
                        modelIsDefault: modelTarget(mode.model) === undefined,
                        // The SDK's own verdict on the mode it will enforce —
                        // settings (permissions.deny/ask/defaultMode/
                        // disableBypassPermissionsMode) can override what we
                        // asked for. runClaude publishes THIS, not our intent.
                        permissionMode: systemInit.permissionMode,
                    });
                }

                // Session id is still in memory, wait until session file is written to disk
                // Start a watcher for to detect the session id
                if (systemInit.session_id) {
                    logger.debug(`[claudeRemote] Waiting for session file to be written to disk: ${systemInit.session_id}`);
                    const projectDir = getProjectPath(opts.path);
                    const found = await awaitFileExist(join(projectDir, `${systemInit.session_id}.jsonl`), 30000);
                    logger.debug(`[claudeRemote] Session file found: ${systemInit.session_id} ${found}`);
                    if (!found) {
                        // The transcript never landed on disk within the grace
                        // window. We still register the id so the (now
                        // bounded) scanner watcher can pick it up if it shows
                        // up late and otherwise drops it cleanly instead of
                        // wedging — but surface the anomaly so a stuck remote
                        // launch is visible in the app rather than a silent
                        // "dead instance".
                        logger.debug(`[claudeRemote] WARNING: session transcript ${systemInit.session_id} never appeared after 30s`);
                        opts.onCompletionEvent?.('⚠️ Claude session did not produce a transcript — the agent may be unresponsive. Try sending your message again.');
                    }
                    opts.onSessionFound(systemInit.session_id);
                }
            }

            // Handle result messages
            if (message.type === 'result') {
                updateThinking(false);
                logger.debug('[claudeRemote] Result received');
                // Authoritative record of tools Claude Code denied without a
                // prompt (deny rules, dontAsk/auto, hook denies). Invisible
                // otherwise — surface it so "yolo still refused X" is diagnosable.
                const denials = (message as { permission_denials?: Array<{ tool_name?: string }> }).permission_denials;
                if (denials && denials.length > 0) {
                    logger.warn(`[claudeRemote] ${denials.length} tool call(s) auto-denied by Claude Code policy: ${denials.map((d) => d.tool_name ?? '?').join(', ')}`);
                }

                // Send completion messages
                if (isCompactCommand) {
                    const compactSucceeded = message.subtype === 'success';
                    logger.debug(`[claudeRemote] Compaction ${compactSucceeded ? 'completed' : 'failed'}`);
                    if (opts.onCompletionEvent) {
                        opts.onCompletionEvent(message.subtype === 'success'
                            ? 'Compaction completed'
                            : `Compaction failed: ${message.errors?.join('\n') || message.subtype}`);
                    }
                    isCompactCommand = false;
                }

                // Send ready event
                opts.onReady(message);

                // A turn that ended in a failed OAuth refresh poisons this
                // process for good (Claude Code caches the verdict): end the
                // Query so the launcher's next iteration spawns a fresh one
                // for the next queued message, instead of replaying the error.
                const recycleReason = queryRecycleReason(message, lastAssistantError);
                lastAssistantError = undefined;
                if (recycleReason) {
                    logger.warn(`[claudeRemote] Ending SDK query after ${recycleReason}; the next message starts a fresh Claude Code process`);
                    opts.onCompletionEvent?.(QUERY_RECYCLE_NOTICE[recycleReason]);
                    opts.onAuthFailure?.(recycleReason);
                    messages.end();
                    continue;
                }

                // Wait for next user message without blocking the message loop.
                // Background task messages (task_started, task_progress, task_notification)
                // continue flowing through while we wait for user input.
                opts.nextMessage().then(async (next) => {
                    if (!next) {
                        messages.end();
                        return;
                    }
                    // A model change is applied IN PLACE (see claudeLiveModel.ts)
                    // — this is the only mode field the SDK can move on a live
                    // Query, which is why `model` is deliberately NOT part of the
                    // launcher's relaunch hash. A rejected switch (a dead alias
                    // from a stale client) must not take the turn down: report it
                    // and keep running the model that is already loaded.
                    if (needsModelSwitch(mode.model, next.mode.model)) {
                        try {
                            await response.setModel(modelTarget(next.mode.model));
                            logger.debug(`[claudeRemote] Model switched to ${modelTarget(next.mode.model) ?? 'default'}`);
                        } catch (e) {
                            logger.debug(`[claudeRemote] setModel failed: ${e instanceof Error ? e.message : String(e)}`);
                            opts.onCompletionEvent?.(modelSwitchFailureNotice(next.mode.model, e));
                            next = { ...next, mode: { ...next.mode, model: mode.model } };
                        }
                    }
                    mode = next.mode;
                    updateThinking(true);
                    messages.push({
                        type: 'user',
                        parent_tool_use_id: null,
                        origin: { kind: 'human' },
                        message: { role: 'user', content: next.message },
                    });
                }).catch(() => {
                    messages.end();
                });
            }

            // Handle tool result
            if (message.type === 'user') {
                const msg = message as SDKUserMessage;
                if (msg.message.role === 'user' && Array.isArray(msg.message.content)) {
                    for (let c of msg.message.content) {
                        if (c.type === 'tool_result' && c.tool_use_id && opts.isAborted(c.tool_use_id)) {
                            logger.debug('[claudeRemote] Tool aborted, exiting claudeRemote');
                            return;
                        }
                    }
                }
            }
        }
    } catch (e) {
        if (e instanceof AbortError) {
            logger.debug(`[claudeRemote] Aborted`);
            // Ignore
        } else {
            throw e;
        }
    } finally {
        updateThinking(false);
    }
}
