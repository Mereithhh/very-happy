import { notifyDaemonClaudeAuthFailed } from '@/daemon/controlClient';
import { render } from "ink";
import { Session } from "./session";
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { RemoteModeDisplay } from "@/ui/ink/RemoteModeDisplay";
import React from "react";
import { claudeRemote } from "./claudeRemote";
import { PermissionHandler } from "./utils/permissionHandler";
import { rewriteQueuedPermissionMode } from "./utils/queuedPermissionMode";
import { Future } from "@/utils/future";
import { SDKAssistantMessage, SDKMessage, SDKUserMessage } from "./sdk";
import { formatClaudeMessageForInk } from "@/ui/messageFormatterInk";
import { logger } from "@/ui/logger";
import { SDKToLogConverter } from "./utils/sdkToLogConverter";
import { EnhancedMode } from "./loop";
import { RawJSONLines } from "@/claude/types";
import { OutgoingMessageQueue } from "./utils/OutgoingMessageQueue";
import { getToolName } from "./utils/getToolName";
import { getAskUserQuestionToolCallIds } from "./utils/questionNotification";
import { cleanupStdinAfterInk } from "@/utils/terminalStdinCleanup";
import type { MessageParam } from '@anthropic-ai/sdk/resources';
import { contentLogMetadata } from '@/utils/contentLogMetadata';
import { applyClaudeResultLifecycle } from './utils/remoteResultLifecycle';
import { applyClaudeSdkMetadata } from './claudeSdkMetadata';
import { createTurnSteeringController } from './turnSteering';
import { appendStagedAttachmentsToPrompt, chatAttachmentDirectory, stageClaudeAttachments } from './utils/attachmentContent';
import { configuration } from '@/configuration';
import { ensurePrivateDirectory } from '@/utils/secureFiles';
import { isClaudeEdeOnlySdkError, isClaudeInterruptSentinelContent } from './utils/interruptNoise';
import { parseClaudePermissionMode, type ClaudeSdkPermissionMode } from './utils/permissionMode';
import { LaunchModeGate } from './launchModeGate';

interface PermissionsField {
    date: number;
    result: 'approved' | 'denied';
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    allowedTools?: string[];
}

export async function claudeRemoteLauncher(
    session: Session,
    onPermissionModeChange?: (mode: ClaudeSdkPermissionMode) => void,
    /** SDK-reported effective mode from system/init (B-262 batch 2). */
    onEffectivePermissionMode?: (mode: string) => void,
): Promise<'switch' | 'exit'> {
    logger.debug('[claudeRemoteLauncher] Starting remote launcher');

    // Check if we have a TTY for UI rendering
    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    logger.debug(`[claudeRemoteLauncher] TTY available: ${hasTTY}`);

    // Configure terminal
    let messageBuffer = new MessageBuffer();
    let inkInstance: any = null;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(RemoteModeDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? session.logPath : undefined,
            onExit: async () => {
                // Exit the entire client
                logger.debug('[remote]: Exiting client via Ctrl-C');
                if (!exitReason) {
                    exitReason = 'exit';
                }
                await abort();
            },
            onSwitchToLocal: () => {
                // Switch to local mode
                logger.debug('[remote]: Switching to local mode via double space');
                doSwitch();
            }
        }), {
            exitOnCtrlC: false,
            patchConsole: false
        });
    }

    if (hasTTY) {
        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.setEncoding("utf8");
    }

    // Handle abort
    let exitReason: 'switch' | 'exit' | null = null;
    let abortController: AbortController | null = null;
    let abortFuture: Future<void> | null = null;
    const turnSteering = createTurnSteeringController();

    async function abort() {
        if (abortController && !abortController.signal.aborted) {
            abortController.abort();
        }
        await abortFuture?.promise;
    }

    async function doAbort() {
        logger.debug('[remote]: doAbort');
        session.onAbort();
        await abort();
    }

    async function doSwitch() {
        logger.debug('[remote]: doSwitch');
        if (!exitReason) {
            exitReason = 'switch';
        }
        await abort();
    }

    // When to abort
    session.client.rpcHandlerManager.registerHandler('abort', doAbort); // When abort clicked
    // Steering ends only the foreground turn and keeps the streaming query
    // alive, so the queued follow-up remains in this session without emitting
    // the explicit "Aborted by user" lifecycle event.
    session.client.rpcHandlerManager.registerHandler('steer', async () => {
        await turnSteering.steer();
    });
    session.client.rpcHandlerManager.registerHandler('switch', doSwitch); // When switch clicked
    // Removed catch-all stdin handler - now handled by RemoteModeDisplay keyboard handlers

    let livePermissionModeHandler: ((mode: ClaudeSdkPermissionMode) => Promise<ClaudeSdkPermissionMode>) | null = null;
    // Idle (no active query): there is nothing to steer, so just move the
    // process-level mode. The next queued message starts its query with it.
    // Old clients (capability v1) never call this while idle.
    let idlePermissionModeHandler: ((mode: ClaudeSdkPermissionMode) => ClaudeSdkPermissionMode) | null = null;
    session.client.rpcHandlerManager.registerHandler<{ mode?: unknown }, { mode: ClaudeSdkPermissionMode }>(
        'set-permission-mode',
        async (request) => {
            const requestedMode = parseClaudePermissionMode(request?.mode);
            if (!requestedMode) throw new Error('Invalid Claude permission mode');
            if (livePermissionModeHandler) return { mode: await livePermissionModeHandler(requestedMode) };
            if (idlePermissionModeHandler) return { mode: idlePermissionModeHandler(requestedMode) };
            throw new Error('No active Claude query');
        },
    );

    // Create permission handler
    const permissionHandler = new PermissionHandler(session);

    // Before the first launch iteration installs the queue-aware
    // commitPermissionMode, still accept idle mode changes: enforce locally and
    // report upward so runClaude publishes the new effective mode.
    idlePermissionModeHandler = (nextMode) => {
        permissionHandler.handleModeChange(nextMode);
        onPermissionModeChange?.(nextMode);
        return nextMode;
    };

    // Drop any permission requests left over in agent state from a
    // previous CLI process that died while a tool prompt was open. The
    // in-memory pendingRequests map is fresh and empty, but the server
    // still has `requests: { [id]: {...} }` and the app shows a spinner
    // + "Permission required" banner that no click can clear — the
    // previous process is gone and the new one has no record of the id.
    // reset() moves any stale entries to completedRequests with status
    // 'canceled' so the UI reflects what actually happened.
    permissionHandler.reset('Previous CLI process exited before responding');

    // Create outgoing message queue
    const messageQueue = new OutgoingMessageQueue(
        (logMessage) => session.client.sendClaudeSessionMessage(logMessage)
    );

    // Set up callback to release delayed messages when permission is requested
    permissionHandler.setOnPermissionRequest((toolCallId: string) => {
        messageQueue.releaseToolCall(toolCallId);
    });

    // Create SDK to Log converter (pass responses from permissions)
    const sdkToLogConverter = new SDKToLogConverter({
        sessionId: session.sessionId || 'unknown',
        cwd: session.path,
        version: process.env.npm_package_version
    }, permissionHandler.getResponses());


    // Handle messages
    let ongoingToolCalls = new Map<string, { parentToolCallId: string | null }>();
    let notifiedQuestionToolCalls = new Set<string>();

    function onMessage(message: SDKMessage) {

        // Claude Code emits this synthetic user frame for an interrupted
        // query. It is engine bookkeeping, not conversation content.
        if (message.type === 'user'
            && isClaudeInterruptSentinelContent((message as SDKUserMessage).message.content)) {
            sdkToLogConverter.convert(message);
            return;
        }

        // Write to message log
        formatClaudeMessageForInk(message, messageBuffer);

        // Track active tool calls
        if (message.type === 'assistant') {
            let umessage = message as SDKAssistantMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_use') {
                        logger.debug('[remote]: detected tool use ' + c.id! + ' parent: ' + umessage.parent_tool_use_id);
                        ongoingToolCalls.set(c.id!, { parentToolCallId: umessage.parent_tool_use_id ?? null });
                    }
                    // Record top-level assistant text so turn-end can fire a
                    // `reply_done` notification with a meaningful snippet.
                    // Ignore sidechain (sub-agent) output — only the main reply.
                    if (c.type === 'text' && (umessage.parent_tool_use_id ?? null) === null) {
                        session.noteAssistantOutput(typeof c.text === 'string' ? c.text : undefined);
                    }
                }
            }
        }

        // Notify once when Claude asks the user a native clarifying question
        for (const toolCallId of getAskUserQuestionToolCallIds(message)) {
            if (notifiedQuestionToolCalls.has(toolCallId)) {
                continue;
            }
            notifiedQuestionToolCalls.add(toolCallId);
            session.api.push().sendSessionNotification({
                kind: 'question',
                metadata: session.client.getMetadata(),
                data: {
                    sessionId: session.client.sessionId,
                    tool: 'AskUserQuestion',
                    toolCallId,
                    type: 'question_request',
                    provider: 'claude',
                }
            });
        }

        if (message.type === 'user') {
            let umessage = message as SDKUserMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_result' && c.tool_use_id) {
                        ongoingToolCalls.delete(c.tool_use_id);

                        // When tool result received, release any delayed messages for this tool call
                        messageQueue.releaseToolCall(c.tool_use_id);
                    }
                }
            }
        }

        // Convert SDK message to log format and send to client
        const logMessage = sdkToLogConverter.convert(message);
        if (logMessage) {
            // Add permissions field to tool result content
            if (logMessage.type === 'user' && logMessage.message?.content) {
                const content = Array.isArray(logMessage.message.content)
                    ? logMessage.message.content
                    : [];

                // Modify the content array to add permissions to each tool_result
                for (let i = 0; i < content.length; i++) {
                    const c = content[i];
                    if (c.type === 'tool_result' && c.tool_use_id) {
                        const responses = permissionHandler.getResponses();
                        const response = responses.get(c.tool_use_id);

                        if (response) {
                            const permissions: PermissionsField = {
                                date: response.receivedAt || Date.now(),
                                result: response.approved ? 'approved' : 'denied'
                            };

                            // Add optional fields if they exist
                            if (response.mode) {
                                permissions.mode = response.mode;
                            }

                            if (response.allowTools && response.allowTools.length > 0) {
                                permissions.allowedTools = response.allowTools;
                            }

                            // Add permissions directly to the tool_result content object
                            content[i] = {
                                ...c,
                                permissions
                            };
                        }
                    }
                }
            }

            // Queue message with optional delay for tool calls
            if (logMessage.type === 'assistant' && message.type === 'assistant') {
                const assistantMsg = message as SDKAssistantMessage;
                const toolCallIds: string[] = [];

                if (assistantMsg.message.content && Array.isArray(assistantMsg.message.content)) {
                    for (const block of assistantMsg.message.content) {
                        if (block.type === 'tool_use' && block.id) {
                            toolCallIds.push(block.id);
                        }
                    }
                }

                if (toolCallIds.length > 0) {
                    // Check if this is a sidechain tool call (has parent_tool_use_id)
                    const isSidechain = assistantMsg.parent_tool_use_id !== undefined;

                    if (!isSidechain) {
                        // Top-level tool call - queue with delay
                        messageQueue.enqueue(logMessage, {
                            delay: 250,
                            toolCallIds
                        });
                        return; // Don't queue again below
                    }
                }
            }

            // Queue all other messages immediately (no delay)
            messageQueue.enqueue(logMessage);
        }

        // Insert a fake message to start the sidechain
        if (message.type === 'assistant') {
            let umessage = message as SDKAssistantMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_use' && c.name === 'Task' && c.input && typeof (c.input as any).prompt === 'string') {
                        const logMessage2 = sdkToLogConverter.convertSidechainUserMessage(c.id!, (c.input as any).prompt);
                        if (logMessage2) {
                            messageQueue.enqueue(logMessage2);
                        }
                    }
                }
            }
        }
    }

    type ParkedMessage = {
        message: MessageParam['content'];
        mode: EnhancedMode;
    };

    try {
        // Process-scoped, NOT per-launch: it carries the parked message across
        // the relaunch that message caused. `reset()` in each launch's finally
        // clears only the adopted mode, which is what makes a fresh launch
        // accept its first message. Parking and adopting live together here on
        // purpose — see launchModeGate.ts.
        const modeGate = new LaunchModeGate<EnhancedMode, ParkedMessage>(session.queue.modeHasher);

        // Track session ID to detect when it actually changes
        // This prevents context loss when mode changes (permission mode, model, etc.)
        // without starting a new session. Only reset parent chain when session ID
        // actually changes (e.g., new session started or /clear command used).
        // See: https://github.com/anthropics/happy-cli/issues/143
        let previousSessionId: string | null = null;
        while (!exitReason) {
            logger.debug('[remote]: launch');
            messageBuffer.addMessage('═'.repeat(40), 'status');

            // Only reset parent chain and show "new session" message when session ID actually changes
            const isNewSession = session.sessionId !== previousSessionId;
            if (isNewSession) {
                messageBuffer.addMessage('Starting new Claude session...', 'status');
                permissionHandler.reset(); // Reset permissions before starting new session
                sdkToLogConverter.resetParentChain(); // Reset parent chain for new conversation
                logger.debug(`[remote]: New session detected (previous: ${previousSessionId}, current: ${session.sessionId})`);
            } else {
                messageBuffer.addMessage('Continuing Claude session...', 'status');
                logger.debug(`[remote]: Continuing existing session: ${session.sessionId}`);
            }

            previousSessionId = session.sessionId;
            const controller = new AbortController();
            abortController = controller;
            abortFuture = new Future<void>();
            // Process-level mode owner: every path that changes the effective mode
            // (idle RPC, plan approval, approve-with-mode) lands here so the queue
            // hash, the local enforcer and runClaude's published metadata agree.
            const commitPermissionMode = (nextMode: ClaudeSdkPermissionMode): ClaudeSdkPermissionMode => {
                permissionHandler.handleModeChange(nextMode);
                modeGate.amend({ permissionMode: nextMode });
                // B-262 batch 2: messages already queued carry the mode snapshot
                // taken when they were enqueued. An explicit switch (idle RPC,
                // plan approval, approve-with-mode) is newer than all of them —
                // rewrite their snapshots so the next queued message cannot
                // pull the process back to a stale plan/default.
                rewriteQueuedPermissionMode(session.queue.queue, session.queue.modeHasher, nextMode);
                modeGate.amendParked({ permissionMode: nextMode });
                onPermissionModeChange?.(nextMode);
                return nextMode;
            };
            idlePermissionModeHandler = commitPermissionMode;
            permissionHandler.setOnModeChanged((nextMode) => { commitPermissionMode(nextMode); });
            try {
                const attachmentDirectory = chatAttachmentDirectory(configuration.happyHomeDir, session.client.sessionId);
                await ensurePrivateDirectory(attachmentDirectory);
                const remoteResult = await claudeRemote({
                    sessionId: session.sessionId,
                    path: session.path,
                    additionalDirectories: [attachmentDirectory],
                    allowedTools: session.allowedTools ?? [],
                    mcpServers: session.mcpServers,
                    hookSettingsPath: session.hookSettingsPath,
                    jsRuntime: session.jsRuntime,
                    canCallTool: permissionHandler.handleToolCall,
                    onElicitation: permissionHandler.handleElicitation,
                    onUserDialog: permissionHandler.handleUserDialog,
                    isAborted: (toolCallId: string) => {
                        return permissionHandler.isAborted(toolCallId);
                    },
                    nextMessage: async () => {
                        // takeParked() adopts as it hands the message over — this
                        // launch exists BECAUSE of that mode. (The two used to be
                        // separate steps and the adopt was missing: B-292.)
                        const parked = modeGate.takeParked();
                        if (parked) {
                            permissionHandler.handleModeChange(parked.mode.permissionMode);
                            return parked;
                        }

                        let msg = await session.queue.waitForMessagesAndGetAsString(controller.signal);

                        // Check if mode has changed
                        if (msg) {
                            if (modeGate.requiresRelaunch(msg.hash, msg.isolate)) {
                                logger.debug('[remote]: mode has changed, pending message');
                                // Stage NOW, not on replay: the queue item is the
                                // only reference to these bytes
                                // (drainAttachmentsForUserMessage hands the bucket
                                // over destructively), and the replay path returns
                                // the parked value verbatim. Parking the raw
                                // message dropped every attachment that travelled
                                // with a mode change — silently, with the model
                                // answering as if no image had been sent.
                                const parkedAttachments = msg.attachments ?? [];
                                const parkedStaged = parkedAttachments.length > 0
                                    ? await stageClaudeAttachments(parkedAttachments, {
                                        happyHomeDir: configuration.happyHomeDir,
                                        sessionId: session.client.sessionId,
                                    })
                                    : [];
                                modeGate.park({
                                    message: parkedStaged.length > 0
                                        ? appendStagedAttachmentsToPrompt(msg.message, parkedStaged)
                                        : msg.message,
                                    mode: msg.mode,
                                });
                                return null;
                            }
                            modeGate.adopt(msg.mode);
                            permissionHandler.handleModeChange(msg.mode.permissionMode);

                            // Per-message attachments are already claimed by the message
                            // when it was pushed onto the queue, so there is no race window
                            // to wait out here — just consume what travelled with the batch.
                            const attachments = msg.attachments ?? [];
                            if (attachments.length > 0) {
                                const staged = await stageClaudeAttachments(attachments, {
                                    happyHomeDir: configuration.happyHomeDir,
                                    sessionId: session.client.sessionId,
                                });
                                logger.debug(`[remote] Staged ${staged.length} attachment(s) for the coding agent`);
                                return {
                                    message: appendStagedAttachmentsToPrompt(msg.message, staged),
                                    mode: msg.mode,
                                };
                            }

                            return {
                                message: msg.message,
                                mode: msg.mode
                            }
                        }

                        // Exit
                        return null;
                    },
                    onSessionFound: (sessionId) => {
                        // Update converter's session ID when new session is found
                        sdkToLogConverter.updateSessionId(sessionId);
                        session.onSessionFound(sessionId);
                    },
                    onSDKMetadata: (metadata) => {
                        logger.debug('[remote] SDK metadata received, updating session:', {
                            toolCount: metadata.tools?.length ?? 0,
                            slashCommandCount: metadata.slashCommands?.length ?? 0,
                            mcpServerCount: metadata.mcpServers?.length ?? 0,
                            skillCount: metadata.skills?.length ?? 0,
                        });
                        session.client.updateMetadata((currentMetadata) =>
                            applyClaudeSdkMetadata(currentMetadata, metadata));
                        if (metadata.permissionMode) onEffectivePermissionMode?.(metadata.permissionMode);
                    },
                    onQueryReady: (q) => {
                        turnSteering.setInterrupt(q.interrupt);
                        session.setSteerHandler(async (input) => {
                            // Steer injects into the RUNNING turn, so it is only
                            // legal when the live Query was built for this mode.
                            // The gate's hash covers exactly what query() fixes at
                            // creation — `model` is deliberately NOT among them
                            // (claudeModeHash): a steer that also moves the model
                            // is accepted and runs on the loaded model, and
                            // claudeRemote.steer keeps that model so the switch
                            // still lands at the next turn boundary.
                            if (!modeGate.matches(input.mode)) return false;

                            let message: MessageParam['content'] = input.message;
                            if (input.attachments?.length) {
                                const staged = await stageClaudeAttachments(input.attachments, {
                                    happyHomeDir: configuration.happyHomeDir,
                                    sessionId: session.client.sessionId,
                                });
                                message = appendStagedAttachmentsToPrompt(input.message, staged);
                            }

                            // Staging can outlive the turn. Recheck before
                            // touching the live input stream; false falls back
                            // to the ordinary durable queue in runClaude.
                            if (!session.thinking || !modeGate.matches(input.mode)) return false;
                            q.steer(message, input.mode);
                            return true;
                        });
                        permissionHandler.setPermissionModeUpdater(async (mode) => {
                            await q.setPermissionMode(mode);
                        });
                        livePermissionModeHandler = async (nextMode) => {
                            await permissionHandler.setLivePermissionMode(nextMode);
                            modeGate.amend({ permissionMode: nextMode });
                            onPermissionModeChange?.(nextMode);
                            return nextMode;
                        };
                    },
                    onThinkingChange: session.onThinkingChange,
                    claudeEnvVars: session.claudeEnvVars,
                    claudeArgs: session.claudeArgs,
                    onMessage,
                    onCompletionEvent: (message: string) => {
                        logger.debug('[remote]: Completion event received:', contentLogMetadata(message));
                        session.client.sendSessionEvent({ type: 'message', message });
                    },
                    onAuthFailure: (reason: string) => {
                        // B-276: structured marker for the web (old web strips
                        // `kind`; the plain-text event above still renders) +
                        // immediate daemon re-probe.
                        session.client.sendSessionEvent({ type: 'message', message: `Claude Code auth: ${reason}`, kind: 'claude-auth-failed' });
                        void notifyDaemonClaudeAuthFailed(session.client.sessionId)
                            .catch((error) => logger.debug('[remote]: auth_failed report to daemon failed:', error));
                    },
                    onSessionReset: () => {
                        logger.debug('[remote]: Session reset');
                        session.clearSessionId();
                    },
                    onReady: (result) => {
                        if (turnSteering.consumeReady()) {
                            session.client.closeClaudeSessionTurn('cancelled');
                            return;
                        }
                        applyClaudeResultLifecycle(result, {
                            closeCompleted: () => session.client.closeClaudeSessionTurn('completed'),
                            closeFailed: (error) => session.client.closeClaudeSessionTurn('failed', { error }),
                            onFailed: (error) => session.onSessionError(error),
                            onCompleted: () => {
                                const idle = !modeGate.hasParked && session.queue.size() === 0;
                                // Account-encrypted feed notification on turn end:
                                // reply_done if Claude produced output, else input_needed
                                // when the session is idle awaiting the user (best-effort).
                                session.onTurnEnd(idle);
                                if (idle) {
                                    session.api.push().sendSessionNotification({
                                        kind: 'done',
                                        metadata: session.client.getMetadata(),
                                        data: {
                                            sessionId: session.client.sessionId,
                                            type: 'ready',
                                            provider: 'claude',
                                        }
                                    });
                                }
                            },
                        });
                    },
                    signal: abortController.signal,
                });
                
                // Consume one-time Claude flags after spawn
                session.consumeOneTimeFlags();
                
                if (!exitReason && abortController.signal.aborted) {
                    session.client.closeClaudeSessionTurn('cancelled');
                    session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                }
            } catch (e) {
                logger.debug('[remote]: launch error', e);
                if (!exitReason) {
                    if (isClaudeEdeOnlySdkError(e)) {
                        session.client.closeClaudeSessionTurn('cancelled');
                        continue;
                    }
                    session.client.closeClaudeSessionTurn('failed');
                    session.client.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
                    // Account-encrypted feed notification (best-effort).
                    session.onSessionError(e instanceof Error ? e.message : 'Process exited unexpectedly');
                    continue;
                }
            } finally {

                turnSteering.reset();
                session.setSteerHandler(null);
                livePermissionModeHandler = null;
                permissionHandler.setPermissionModeUpdater(undefined);
                sdkToLogConverter.resetTransientState();

                logger.debug('[remote]: launch finally');

                // Terminate all ongoing tool calls
                for (let [toolCallId, { parentToolCallId }] of ongoingToolCalls) {
                    const converted = sdkToLogConverter.generateInterruptedToolResult(toolCallId, parentToolCallId);
                    if (converted) {
                        logger.debug('[remote]: terminating tool call ' + toolCallId + ' parent: ' + parentToolCallId);
                        session.client.sendClaudeSessionMessage(converted);
                    }
                }
                ongoingToolCalls.clear();

                // Flush any remaining messages in the queue
                logger.debug('[remote]: flushing message queue');
                await messageQueue.flush();
                messageQueue.destroy();
                logger.debug('[remote]: message queue flushed');

                // Reset abort controller and future
                abortController = null;
                abortFuture?.resolve(undefined);
                abortFuture = null;
                logger.debug('[remote]: launch done');
                permissionHandler.reset();
                modeGate.reset();
            }
        }
    } finally {

        // Clean up permission handler
        permissionHandler.reset();

        // Reset Terminal
        const t0 = Date.now();
        logger.debug(`[remote]: cleanup begin exitReason=${exitReason} hasInk=${!!inkInstance} rawMode=${(process.stdin as any).isRaw}`);
        if (inkInstance) {
            inkInstance.unmount();
        }
        logger.debug(`[remote]: ink.unmount() done +${Date.now() - t0}ms rawMode=${(process.stdin as any).isRaw}`);

        // Drain any keystrokes that landed in stdin while Ink owned it (e.g.
        // extra spaces from the double-space switch confirmation, or anything
        // typed before the user perceives that the switch has completed) so
        // they don't leak into the next interactive child process when local
        // mode takes stdin back via stdio: 'inherit'. Raw mode stays on for
        // the whole window so the kernel does not echo any in-flight bytes
        // at whatever screen position Ink last left the cursor.
        await cleanupStdinAfterInk({
            stdin: process.stdin,
            drainMs: 150,
            onDebug: (event) => {
                logger.debug(`[remote]: stdin drain ${event.bytes}B / ${event.chunks} chunk(s) +${Date.now() - t0}ms`);
            },
        });
        logger.debug(`[remote]: cleanup done +${Date.now() - t0}ms rawMode=${(process.stdin as any).isRaw}`);
        messageBuffer.clear();

        // Resolve abort future
        if (abortFuture) { // Just in case of error
            abortFuture.resolve(undefined);
        }
    }

    return exitReason || 'exit';
}
