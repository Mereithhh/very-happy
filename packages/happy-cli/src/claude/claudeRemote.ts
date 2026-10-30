import type { RuntimeQuery } from './runtimeControls';
import type { SideQuestionLiveAsk, SideQuestionLiveResponse } from './sideQuestion';
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
import { compactOutcomeEvent, readCompactStatus, type ClaudeCompactStatus } from './compactOutcome';
import type { JsRuntime } from "./runClaude";
import { contentLogMetadata } from '@/utils/contentLogMetadata';
import type { ClaudeSdkMetadata } from './claudeSdkMetadata';
import { modelSwitchFailureNotice, modelTarget, needsModelSwitch } from './claudeLiveModel';
import { formatClaudeTimingLine, type ClaudeTurnMarks } from './claudeTiming';
import { decideWarmAdoption, formatPrewarmLine, type ClaudePrewarmLease, type WarmAdoptionDecision } from './claudePrewarm';
import { TimeoutError, withTimeout } from './utils/withTimeout';
import { createClaudeTurnTracker, readClaudeSessionState } from './claudeTurnEnd';
import { retiredModelFrom, retiredModelNotice, type RetiredModels } from './claudeRetiredModel';
import {
    createClaudeCommandTracker,
    INTERRUPT_CANCEL_QUEUED_CAPABILITY,
    MSG_LIFECYCLE_CAPABILITY,
    readClaudeCommandLifecycle,
    type ClaudeInterruptReceipt,
    type ClaudeUnconfirmedCommand,
} from './claudeCommandLifecycle';

type Query = ReturnType<typeof query>;

/** B-634 ②: what a tracked user message carried, so an unconfirmed one can be sent again. */
export type ClaudeSentCommand = { message: MessageParam['content']; mode: EnhancedMode };

/** B-631: budget for the in-place model switch before the next prompt (Orca's default control deadline). */
const SET_MODEL_TIMEOUT_MS = 30_000;

const PROMPT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Only a real UUID may become a transcript uuid; anything else keeps Claude's own. */
function promptUuid(uuid: string | undefined): { uuid?: SDKUserMessage['uuid'] } {
    return uuid && PROMPT_UUID_RE.test(uuid) ? { uuid: uuid as SDKUserMessage['uuid'] } : {};
}

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
    onQueryReady?: (query: RuntimeQuery & {
        setPermissionMode: (mode: string) => Promise<void>;
        /** Live model switch; rejects on an alias Claude Code does not know. */
        setModel: (model?: string) => Promise<void>;
        interrupt: () => Promise<void>;
        /** `localKey` (B-631) becomes the steer's transcript uuid when it is a real UUID. */
        steer: (message: MessageParam['content'], mode: EnhancedMode, localKey?: string) => void;
        /** B-482: Claude Code's own `/btw` — a `side_question` control request answered in-process from live messages. */
        sideQuestion: SideQuestionLiveAsk;
    }) => void,
    /** Path to temporary settings file with SessionStart hook (required for session tracking) */
    hookSettingsPath: string,
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    jsRuntime?: JsRuntime,

    // Dynamic parameters
    /**
     * `enqueuedAt` (optional) only feeds the B-515 timing log. `uuid` (B-528)
     * becomes the prompt's transcript uuid so a web edit/delete can find it.
     */
    nextMessage: () => Promise<{ message: MessageParam['content'], mode: EnhancedMode, enqueuedAt?: number, uuid?: string } | null>,
    onReady: (result?: SDKResultMessage) => void,
    isAborted: (toolCallId: string) => boolean,

    // Callbacks
    onSessionFound: (id: string) => void,
    onThinkingChange?: (thinking: boolean) => void,
    onMessage: (message: SDKMessage) => void,
    /** B-309: token-level partials and progress frames, split off BEFORE
     *  onMessage. They are relayed live on a bypass channel and must never
     *  reach the persisted transcript — see streamRelay.ts. */
    onStreamFrame?: (message: import('./streamRelay').StreamRelayInput) => void,
    onCompletionEvent?: (message: string) => void,
    /** B-276: the turn ended with an auth failure that poisons this Query. */
    onAuthFailure?: (reason: string) => void,
    onSessionReset?: () => void,
    onSDKMetadata?: (metadata: ClaudeSdkMetadata) => void,
    /** B-631: uuid-stamped user messages (prompts, steers) Claude Code confirmed it never read — a Stop swept them; the launcher tombstones them (B-332). */
    onCommandsDropped?: (uuids: string[]) => void,
    /**
     * B-634 ②: uuid-stamped messages this Query handed to Claude Code that it
     * never confirmed (`command_lifecycle started`) before the Query ended —
     * only reported when the CLI emits lifecycle frames at all. `aborted`: the
     * launcher's abort (Stop / exit / switch) ended it, not a fault.
     */
    onCommandsUnconfirmed?: (commands: ClaudeUnconfirmedCommand<ClaudeSentCommand>[], context: { aborted: boolean }) => void,
    /** B-634 ③: session-scoped retired model ids; a message asking for one runs on the default. */
    retiredModels?: RetiredModels,
    /**
     * B-515: start a warm Query with this lease's predicted mode BEFORE the
     * first message; adopted when the first message matches, closed otherwise.
     * Only passed for a fresh session's first launch (claudePrewarm.ts).
     */
    prewarm?: ClaudePrewarmLease,
    /**
     * The start-up args (`--resume <id>` / `--continue`) were acted on: a
     * Claude process now runs on them, or `/clear` deliberately dropped them.
     * Never called when the launch ends before that (no message, or the first
     * message was parked for a relaunch) — the launcher must keep them for the
     * launch that does start Claude, or that one opens an empty conversation.
     */
    onStartArgsUsed?: () => void,
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

    // B-631: when a turn is over (claudeTurnEnd.ts) and which user messages a
    // Stop swept before the model read them (claudeCommandLifecycle.ts).
    // Declared before the Query controls below close over them.
    const turn = createClaudeTurnTracker();
    const commandTracker = createClaudeCommandTracker<ClaudeSentCommand>();
    /** Protocol capabilities from the latest system/init — an open set; feature-detect, never version-sniff. */
    let cliCapabilities = new Set<string>();
    const reportDroppedCommands = (uuids: string[]) => {
        if (uuids.length === 0) return;
        logger.debug(`[claudeRemote] ${uuids.length} user message(s) were never read by Claude Code: ${uuids.join(', ')}`);
        opts.onCommandsDropped?.(uuids);
    };

    let callbackDepth = 0;
    const guardCallback = <T extends (...args:any[])=>Promise<any>>(callback:T):T => (async (...args:Parameters<T>) => {
        callbackDepth++;
        try { return await callback(...args); } finally { setImmediate(()=>{callbackDepth--;}); }
    }) as T;

    // The mode canCallTool enforces. A warm Query is created with the
    // predicted mode and moves to the first message's mode on adoption.
    let mode: EnhancedMode = opts.prewarm?.mode ?? { permissionMode: 'default' };

    // Everything query() fixes at creation, from ONE mode. The cold path and
    // the warm Query both come through here — see claudePrewarm.ts.
    const buildSdkOptions = (creationMode: EnhancedMode, io: { settingsPath: string; abort?: AbortSignal }): QueryOptions => {
        const sdkOptions: QueryOptions = {
            cwd: opts.path,
            resume: startFrom ?? undefined,
            mcpServers: opts.mcpServers,
            permissionMode: mapToClaudeMode(creationMode.permissionMode),
            // This is only the SDK safety opt-in; permissionMode/canUseTool still
            // enforce the selected policy. It must be enabled at Query creation so
            // a later explicit live switch to bypassPermissions can succeed.
            allowDangerouslySkipPermissions: true,
            model: creationMode.model,
            fallbackModel: creationMode.fallbackModel,
            customSystemPrompt: creationMode.customSystemPrompt ? creationMode.customSystemPrompt + '\n\n' + systemPrompt : undefined,
            appendSystemPrompt: creationMode.appendSystemPrompt ? creationMode.appendSystemPrompt + '\n\n' + systemPrompt : systemPrompt,
            allowedTools: creationMode.allowedTools ? creationMode.allowedTools.concat(opts.allowedTools) : opts.allowedTools,
            additionalDirectories: opts.additionalDirectories,
            disallowedTools: creationMode.disallowedTools,
            effort: creationMode.effort,
            canCallTool: (toolName, input, options) => opts.canCallTool(toolName, input, mode, options),
            onElicitation: opts.onElicitation,
            onUserDialog: opts.onUserDialog,
            supportedDialogKinds: opts.onUserDialog ? ['refusal_fallback_prompt'] : undefined,
            abort: io.abort,
            settingsPath: io.settingsPath,
            // B-309: token-level partials. Without this the SDK emits nothing
            // between "turn started" and "entire assistant message", which is
            // exactly why the web used to show a spinner where the terminal shows
            // the model thinking out loud. The partials do NOT enter the
            // transcript; they are split off below and relayed on a side channel.
            // Only pay for them when someone is listening.
            includePartialMessages: opts.onStreamFrame ? true : undefined,
        };
        if(sdkOptions.canCallTool) sdkOptions.canCallTool=guardCallback(sdkOptions.canCallTool);
        if(sdkOptions.onElicitation) sdkOptions.onElicitation=guardCallback(sdkOptions.onElicitation);
        if(sdkOptions.onUserDialog) sdkOptions.onUserDialog=guardCallback(sdkOptions.onUserDialog);
        return sdkOptions;
    };

    // Discover once before handing the Query to approval callbacks. Never issue
    // nested control requests from inside a permission callback. Rejects when
    // the initialize handshake fails.
    const discoverModels = async (q: Query): Promise<ClaudeSdkMetadata['models']> => {
        if (typeof q.supportedModels !== 'function') return undefined;
        return (await q.supportedModels()).map((model) => ({
            code: model.value, value: model.displayName, description: model.description,
            resolvedModel: model.resolvedModel,
            ...(model.supportsEffort === false ? { reasoningEfforts: [] }
                : model.supportedEffortLevels ? { reasoningEfforts: model.supportedEffortLevels } : {}),
        }));
    };

    // B-515 phase 1: the warm Query. Started with an EMPTY input iterable, so
    // Claude Code spawns and answers the initialize handshake while the user
    // is still typing; nothing is iterated (and nothing reaches onMessage,
    // onQueryReady or onSessionFound) until the first message adopts it.
    type WarmQuery = {
        response: Query;
        messages: PushableAsyncIterable<SDKUserMessage>;
        lease: ClaudePrewarmLease;
        startedAt: number;
        /** Never rejects — `.then` both ways at creation (an unhandled rejection archives the session). */
        handshake: Promise<{ ok: true; models: ClaudeSdkMetadata['models']; at: number } | { ok: false; at: number }>;
        idleTimer?: ReturnType<typeof setTimeout>;
        /** Unsubscribe from the child's exit (while warm only). */
        offExit?: () => void;
    };
    let warm: WarmQuery | null = null;
    if (opts.prewarm && startFrom) {
        opts.prewarm.discard('resume');
    } else if (opts.prewarm && opts.signal?.aborted) {
        opts.prewarm.discard('aborted');
    } else if (opts.prewarm) {
        const lease = opts.prewarm;
        const abort = new AbortController();
        const onOuterAbort = () => abort.abort();
        // The launcher's abort (stop/switch/exit) reaches the warm process too —
        // before AND after adoption.
        opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
        const messages = new PushableAsyncIterable<SDKUserMessage>();
        const startedAt = Date.now();
        try {
            const response = query({
                prompt: messages,
                options: buildSdkOptions(lease.mode, { settingsPath: lease.hookSettingsPath, abort: abort.signal }),
            });
            const handshake = discoverModels(response).then(
                (models) => ({ ok: true as const, models, at: Date.now() }),
                () => ({ ok: false as const, at: Date.now() }),
            );
            const w: WarmQuery = { response, messages, lease, startedAt, handshake };
            lease.setTeardown(() => {
                if (w.idleTimer) clearTimeout(w.idleTimer);
                try { w.offExit?.(); } catch { /* ignore */ }
                opts.signal?.removeEventListener('abort', onOuterAbort);
                if (warm === w) warm = null;
                messages.end();
                abort.abort();
            });
            w.idleTimer = setTimeout(() => lease.discard('idle'), lease.idleMs);
            w.idleTimer.unref?.();
            // A warm child that dies while idle frees its slot now, not at the
            // idle limit. `transport.onExit` is ProcessTransport's (SDK
            // 0.3.x, not in the public types); only present once spawned, so
            // it is attached after the handshake. Absent → the adoption-time
            // liveness probe still catches it.
            void handshake.then((result) => {
                if (!result.ok) {
                    lease.discard('handshake-failed');
                    return;
                }
                if (warm !== w) return;
                try {
                    const transport = (response as unknown as { transport?: { onExit?: (cb: (error?: unknown) => void) => unknown } }).transport;
                    const off = transport?.onExit?.(() => { if (warm === w) lease.discard('exited'); });
                    if (typeof off === 'function') w.offExit = off as () => void;
                } catch { /* diagnostics only */ }
            });
            warm = w;
            logger.debug(formatPrewarmLine('started', { tag: lease.tag }));
        } catch (error) {
            opts.signal?.removeEventListener('abort', onOuterAbort);
            logger.debug(`[claudeRemote] prewarm query() threw: ${error instanceof Error ? error.message : String(error)}`);
            lease.discard('spawn-failed');
        }
    }
    const discardWarm = (reason: string) => { warm?.lease.discard(reason); };

    // B-634 ③: a retired model id still on a message (the web resends its
    // pick every time) runs on the default instead of failing the turn again.
    // Applied inside the callers, not as a wrapping promise: one more tick
    // before the hand-off would reorder it against the next result.
    const withoutRetiredModel = <T extends { mode: EnhancedMode } | null>(next: T): T => {
        if (!next || !opts.retiredModels) return next;
        const model = opts.retiredModels.effective(next.mode.model);
        return model === next.mode.model ? next : { ...next, mode: { ...next.mode, model } };
    };

    // Get initial message
    let initial: Awaited<ReturnType<typeof opts.nextMessage>>;
    try {
        initial = withoutRetiredModel(await opts.nextMessage());
    } catch (error) {
        discardWarm('error');
        throw error;
    }
    if (!initial) { // No initial message - exit
        discardWarm('exit');
        return;
    }
    // B-515 phase 0: per-turn latency marks, logged once per result.
    let timingTurn = 1;
    let timingMarks: ClaudeTurnMarks = { pushedAt: initial.enqueuedAt ?? Date.now() };

    // Handle special commands (extract text for parsing when content is a block array)
    const initialText = typeof initial.message === 'string'
        ? initial.message
        : (initial.message.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined)?.text ?? '';
    const specialCommand = parseSpecialCommand(initialText);

    // Handle /clear command
    if (specialCommand.type === 'clear') {
        discardWarm('clear');
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Context was reset');
        }
        if (opts.onSessionReset) {
            opts.onSessionReset();
        }
        opts.onStartArgsUsed?.();
        opts.onReady();
        return;
    }

    // Handle /compact command
    let isCompactCommand = false;
    let compactStatus: ClaudeCompactStatus | null = null;
    if (specialCommand.type === 'compact') {
        logger.debug('[claudeRemote] /compact command detected - will process as normal but with compaction behavior');
        isCompactCommand = true;
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Compaction started');
        }
    }

    // B-515: adopt the warm Query when it was built for exactly this message,
    // otherwise close it and take the cold path below — never both.
    let adopted: { response: Query; messages: PushableAsyncIterable<SDKUserMessage>; models: ClaudeSdkMetadata['models'] } | null = null;
    if (warm) {
        const w: WarmQuery = warm;
        const adoptStart = Date.now();
        // Decide first (pure): a predicted miss is closed at once and goes
        // cold without waiting for a handshake it will never use.
        const decision: WarmAdoptionDecision = decideWarmAdoption({ predicted: w.lease.mode, actual: initial.mode, specialCommand: specialCommand.type });
        let reason: string | null = decision.adopt ? null : decision.reason;
        // Predicted hit with the handshake still in flight: WAIT for it — a
        // second (cold) process would only start the same work from scratch.
        const hs = reason ? null : await w.handshake;
        if (!reason) {
            if (warm !== w) {
                reason = 'closed';
            } else if (!hs?.ok) {
                reason = 'handshake-failed';
            } else if (decision.adopt) {
                // Exact permission mode before the prompt; this control round
                // trip doubles as the liveness probe (a warm child that died
                // while idle rejects here). Otherwise a ~1 ms mcpServerStatus.
                try {
                    if (decision.setPermissionMode) {
                        await withTimeout(w.response.setPermissionMode(decision.setPermissionMode), w.lease.adoptTimeoutMs);
                    } else {
                        await withTimeout(w.response.mcpServerStatus(), w.lease.adoptTimeoutMs);
                    }
                } catch {
                    reason = decision.setPermissionMode ? 'set-permission-failed' : 'not-alive';
                }
                if (!reason && decision.switchModel) {
                    try {
                        await withTimeout(w.response.setModel(modelTarget(initial.mode.model)), w.lease.adoptTimeoutMs);
                    } catch {
                        reason = 'set-model-failed';
                    }
                }
                if (!reason && warm !== w) reason = 'closed';
            }
        }
        if (reason || !hs?.ok) {
            w.lease.discard(reason ?? 'handshake-failed');
            warm = null;
        } else {
            if (w.idleTimer) clearTimeout(w.idleTimer);
            try { w.offExit?.(); } catch { /* ignore */ }
            warm = null;
            w.lease.adopt();
            opts.onStartArgsUsed?.();
            adopted = { response: w.response, messages: w.messages, models: hs.models };
            logger.debug(formatPrewarmLine('adopted', {
                warmForMs: adoptStart - w.startedAt,
                handshakeWaitMs: Math.max(0, hs.at - adoptStart),
                adoptMs: Date.now() - adoptStart,
                setPermissionMode: decision.adopt ? decision.setPermissionMode : undefined,
                setModel: decision.adopt && decision.switchModel ? true : undefined,
            }));
        }
    }

    mode = initial.mode;
    const initialUserMessage: SDKUserMessage = {
        type: 'user',
        parent_tool_use_id: null,
        origin: { kind: 'human' },
        ...promptUuid(initial.uuid),
        message: {
            role: 'user',
            content: initial.message,
        },
    };

    let messages: PushableAsyncIterable<SDKUserMessage>;
    let response: Query;
    let models: ClaudeSdkMetadata['models'];
    if (adopted) {
        messages = adopted.messages;
        response = adopted.response;
        models = adopted.models;
        // The process is already past its handshake: measure from the push.
        timingMarks.handshakeAt = Date.now();
        messages.push(initialUserMessage);
    } else {
        // Push initial message
        messages = new PushableAsyncIterable<SDKUserMessage>();
        messages.push(initialUserMessage);
        timingMarks.spawnAt = Date.now();
        opts.onStartArgsUsed?.();
        response = query({
            prompt: messages,
            options: buildSdkOptions(initial.mode, { settingsPath: opts.hookSettingsPath, abort: opts.signal }),
        });
        try {
            models = await discoverModels(response);
        } catch (error) {
            logger.debug('[claudeRemote] Model capability discovery unavailable');
        }
        timingMarks.handshakeAt = Date.now();
    }
    const prewarmTiming = adopted ? 'adopted' as const : undefined;

    // Expose query control methods to permission handler. B-515: a warm Query
    // only gets here once adopted — /btw and runtime controls never bind to a
    // process that has no transcript.
    if (opts.onQueryReady) {
        opts.onQueryReady({
            canControl: () => callbackDepth === 0,
            reloadSkills: () => response.reloadSkills(),
            reloadPlugins: () => response.reloadPlugins(),
            mcpServerStatus: () => response.mcpServerStatus(),
            reconnectMcpServer: (name) => response.reconnectMcpServer(name),
            toggleMcpServer: (name, enabled) => response.toggleMcpServer(name, enabled),
            stopTask: (id) => response.stopTask(id),
            backgroundTasks: (id) => response.backgroundTasks(id),
            rewindFiles: (id, options) => response.rewindFiles(id, options),
            setPermissionMode: (mode: string) => response.setPermissionMode(mode as any),
            setModel: (model?: string) => response.setModel(modelTarget(model)),
            interrupt: async () => {
                // B-631: a Stop also withdraws the steers still queued behind the
                // turn (Orca, claude-structured-control-actions.ts). The SDK's
                // interrupt() takes `{ cancelQueued }` at runtime (sdk.mjs) but
                // the 0.3.296 declaration omits it — hence the narrow assertion.
                // Older CLIs ignore the field and answer without a receipt.
                const cancelQueued = cliCapabilities.has(INTERRUPT_CANCEL_QUEUED_CAPABILITY);
                const receipt = await (response as unknown as {
                    interrupt: (options?: { cancelQueued?: boolean }) => Promise<ClaudeInterruptReceipt>;
                }).interrupt(cancelQueued ? { cancelQueued: true } : undefined);
                const { dropped, stillQueued } = commandTracker.onInterruptReceipt(receipt);
                if (!cancelQueued && stillQueued.length > 0) {
                    // interrupt_receipt_v1 without cancel_queued: withdraw each
                    // survivor by uuid. `false` = the drain loop already took it;
                    // it runs, and its own lifecycle frames settle it.
                    const cancelAsyncMessage = (response as unknown as {
                        cancelAsyncMessage?: (uuid: string) => Promise<unknown>;
                    }).cancelAsyncMessage;
                    if (typeof cancelAsyncMessage === 'function') {
                        for (const uuid of stillQueued) {
                            const cancelled = await cancelAsyncMessage.call(response, uuid).then((value) => value === true, () => false);
                            dropped.push(...commandTracker.onCancelResponse(uuid, cancelled));
                        }
                    }
                }
                reportDroppedCommands(dropped);
            },
            // `request` is the SDK's generic control-request sender (every typed
            // method wraps it); the public types omit `side_question`, the CLI
            // handles it. An abort on `signal` becomes control_cancel_request.
            sideQuestion: async (request, signal) => {
                const raw = await (response as unknown as {
                    request: (req: Record<string, unknown>, opts?: { signal?: AbortSignal }) => Promise<{ response?: unknown }>;
                }).request({ subtype: 'side_question', ...request }, { signal });
                const body = raw?.response;
                return (body && typeof body === 'object' ? body : { response: null }) as SideQuestionLiveResponse;
            },
            steer: (message, nextMode, localKey) => {
                // Steer injects into the CURRENT turn, and a model cannot change
                // mid-turn — keep the one that is actually running so the next
                // turn boundary still sees (and applies) the difference.
                mode = { ...nextMode, model: mode.model };
                // B-631: stamped with the web's localKey so command_lifecycle /
                // the interrupt receipt can name it; a non-UUID key keeps the
                // steer untracked, as before.
                const uuid = promptUuid(localKey);
                if (uuid.uuid) commandTracker.track(uuid.uuid, { message, mode: nextMode });
                messages.push({
                    type: 'user',
                    parent_tool_use_id: null,
                    priority: 'now',
                    origin: { kind: 'human' },
                    ...uuid,
                    message: { role: 'user', content: message },
                });
            },
        });
    }

    // `error` of the latest flagged assistant frame in the current turn — the
    // typed signal for deciding whether this Query is still usable (see
    // utils/remoteQueryRecycle.ts). Reset when the turn's result is handled.
    let lastAssistantError: string | undefined;

    // The first prompt is in the Query's input (pushed; the CLI announces its
    // turn with running/init). Uuid-stamped when the web gave it one, and
    // tracked like every other command, so a Stop that sweeps it before it
    // starts is reported (B-631).
    turn.pushed();
    if (initialUserMessage.uuid) commandTracker.track(initialUserMessage.uuid, { message: initial.message, mode: initial.mode });

    // B-631: a `set_model` the CLI never answered may still land late. Until
    // the next boundary re-sends (whatever model that turn wants), `mode.model`
    // does not reliably describe the loaded model, so the usual "unchanged,
    // skip the request" short-cut is suspended for that one boundary.
    let modelUnconfirmed = false;

    // Hand the next queued message to the Query once the current turn is over.
    // Runs without blocking the message loop: background task frames
    // (task_started, task_progress, task_notification) keep flowing while we
    // wait for user input. B-631: one puller at a time — two results in a row
    // (a pre-empted turn and the one that pre-empted it) used to park two
    // waiters on the queue, which then pushed two queued messages back to back;
    // B-509 is one message per turn end.
    // B-662: the flag drops in the same synchronous step that hands the
    // message to the Query (or ends it), not in a trailing `.finally` a few
    // microtasks later: a result landing in that window (a prompt answered at
    // once, or one more `await` on the pull path) found the flag still up,
    // returned as "already waiting", and nothing pulled again — the queued
    // message sat there until the session was restarted.
    let pullingNext = false;
    const pullNextMessage = () => {
        if (pullingNext) {
            logger.debug('[claudeRemote] Already waiting for the next message');
            return;
        }
        pullingNext = true;
        opts.nextMessage().then(async (pulled) => {
            let next = withoutRetiredModel(pulled);
            if (!next) {
                pullingNext = false;
                messages.end();
                return;
            }
            // A model change is applied IN PLACE (see claudeLiveModel.ts)
            // — this is the only mode field the SDK can move on a live
            // Query, which is why `model` is deliberately NOT part of the
            // launcher's relaunch hash. A rejected switch (a dead alias
            // from a stale client) must not take the turn down: report it
            // and keep running the model that is already loaded. B-631: a
            // switch the CLI never answers is given up after a budget the
            // same way, and the next boundary re-sends even when that turn
            // keeps the model, because the late answer may have landed.
            if (modelUnconfirmed || needsModelSwitch(mode.model, next.mode.model)) {
                try {
                    await withTimeout(response.setModel(modelTarget(next.mode.model)), SET_MODEL_TIMEOUT_MS, 'set_model');
                    modelUnconfirmed = false;
                    logger.debug(`[claudeRemote] Model switched to ${modelTarget(next.mode.model) ?? 'default'}`);
                } catch (e) {
                    logger.debug(`[claudeRemote] setModel failed: ${e instanceof Error ? e.message : String(e)}`);
                    opts.onCompletionEvent?.(modelSwitchFailureNotice(next.mode.model, e));
                    if (e instanceof TimeoutError) modelUnconfirmed = true;
                    next = { ...next, mode: { ...next.mode, model: mode.model } };
                }
            }
            mode = next.mode;
            updateThinking(true);
            turn.pushed();
            const uuid = promptUuid(next.uuid);
            if (uuid.uuid) commandTracker.track(uuid.uuid, { message: next.message, mode: next.mode });
            timingMarks = { pushedAt: next.enqueuedAt ?? Date.now() };
            pullingNext = false;
            messages.push({
                type: 'user',
                parent_tool_use_id: null,
                origin: { kind: 'human' },
                ...uuid,
                message: { role: 'user', content: next.message },
            });
        }).catch(() => {
            pullingNext = false;
            messages.end();
        });
    };

    // A turn that ended in a failed OAuth refresh poisons this process for
    // good (Claude Code caches the verdict): end the Query so the launcher's
    // next iteration spawns a fresh one for the next queued message, instead
    // of replaying the error. True = the Query was ended. `result` is absent
    // for a turn that ended by idle (B-631): the flagged assistant frame is
    // the signal either way.
    const recycleIfPoisoned = (result?: SDKResultMessage): boolean => {
        const recycleReason = queryRecycleReason(result ?? { subtype: 'success' }, lastAssistantError);
        lastAssistantError = undefined;
        if (!recycleReason) return false;
        logger.warn(`[claudeRemote] Ending SDK query after ${recycleReason}; the next message starts a fresh Claude Code process`);
        opts.onCompletionEvent?.(QUERY_RECYCLE_NOTICE[recycleReason]);
        opts.onAuthFailure?.(recycleReason);
        messages.end();
        return true;
    };

    // B-631: Claude Code said the turn is over (session_state_changed idle) and
    // no result did — the end a turn stopped by a fault otherwise never gets.
    // No verdict: the CLI said it is over, not how (Orca, claude-structured-
    // journal-translation.ts). The launcher closes it as completed and pulls
    // the next message exactly as after a result.
    const endTurnWithoutResult = () => {
        updateThinking(false);
        logger.debug(`[claudeRemote] Turn ${timingTurn} ended by session_state_changed idle without a result frame`);
        timingTurn++;
        timingMarks = {};
        if (isCompactCommand) {
            logger.debug('[claudeRemote] /compact ended without a result; outcome unknown');
            isCompactCommand = false;
        }
        opts.onReady(undefined);
        if (!recycleIfPoisoned()) pullNextMessage();
    };

    updateThinking(true);
    try {
        logger.debug(`[claudeRemote] Starting to iterate over response`);

        for await (const message of response) {
            // B-309: partials leave here and never come back. This sits ABOVE
            // the debug log on purpose — `stream_event` arrives ~100 times a
            // second, and `contentLogMetadata` stringifies the whole message
            // while `logToFile` writes synchronously, so logging them would
            // put a full serialize + blocking disk write on the token path.
            // They must not continue into onMessage either: they would
            // traverse the converter only to be dropped, hammering the
            // ordering queue the real messages depend on.
            if (message.type === 'stream_event') {
                // A sub-agent's partials must never join the main draft — they
                // would interleave another agent's sentences into the answer
                // being written. Today the SDK does not forward them at all
                // (`forwardSubagentText` defaults false; measured 2026-09-03:
                // every frame of a Task-running turn came back parent-less),
                // so this guards against that default changing under us.
                if (opts.onStreamFrame && !(message as { parent_tool_use_id?: string | null }).parent_tool_use_id) {
                    opts.onStreamFrame({ type: 'stream_event', event: (message as { event: unknown }).event });
                }
                continue;
            }

            logger.debug(`[claudeRemote] Message ${message.type}`, contentLogMetadata(message));

            if (message.type === 'assistant' && message.error) {
                lastAssistantError = message.error;
            }
            // B-634 ③: Claude Code says the model this session runs does not
            // exist. Put the live Query back on the default (bounded; a late
            // answer is covered by the next boundary's re-send) and stop
            // holding the id for the rest of the session.
            const retired = opts.retiredModels ? retiredModelFrom(message, mode.model) : null;
            if (retired) {
                opts.retiredModels!.retire(retired);
                mode = { ...mode, model: undefined };
                logger.debug(`[claudeRemote] Model ${retired} reported model_not_found; moving the session to the default model`);
                opts.onCompletionEvent?.(retiredModelNotice(retired));
                void withTimeout(response.setModel(undefined), SET_MODEL_TIMEOUT_MS, 'set_model').catch((e) => {
                    logger.debug(`[claudeRemote] setModel(default) after model_not_found failed: ${e instanceof Error ? e.message : String(e)}`);
                    modelUnconfirmed = true;
                });
            }
            if (message.type === 'assistant' && timingMarks.firstAssistantAt === undefined) {
                timingMarks.firstAssistantAt = Date.now();
            } else if (message.type === 'system' && message.subtype === 'init' && timingMarks.initAt === undefined) {
                timingMarks.initAt = Date.now();
            }

            // Progress-bearing system frames. Unlike stream_event these are
            // low-rate, so they keep flowing to onMessage as before (where
            // OutgoingMessageQueue drops them) and are merely copied out.
            if (opts.onStreamFrame && message.type === 'system') {
                const subtype = (message as { subtype?: string }).subtype;
                if (subtype === 'thinking_tokens') {
                    const tokens = message as { estimated_tokens?: number };
                    opts.onStreamFrame({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: tokens.estimated_tokens });
                } else if (subtype === 'status') {
                    const status = message as { status?: string | null };
                    opts.onStreamFrame({ type: 'system', subtype: 'status', status: status.status });
                }
            }

            // Handle messages. During /compact, Claude emits the generated
            // summary as a normal assistant text message before the result.
            // Mark it so downstream UI/protocol mapping can treat it as
            // housekeeping instead of a real assistant response.
            if (isCompactCommand) compactStatus = readCompactStatus(message) ?? compactStatus;
            const outboundMessage = isCompactCommand && message.type === 'assistant'
                ? { ...message, isCompactSummary: true } as SDKMessage
                : message;
            opts.onMessage(outboundMessage);

            // B-631: queue bookkeeping for the user messages we stamped — a
            // terminal state for one that never started means the model never
            // read it.
            const lifecycle = readClaudeCommandLifecycle(message);
            if (lifecycle) reportDroppedCommands(commandTracker.observe(lifecycle));

            // B-631: the CLI's own turn-over signal (see claudeTurnEnd.ts).
            const sessionState = readClaudeSessionState(message);
            if (sessionState) {
                const verdict = turn.onSessionState(sessionState);
                if (verdict === 'end') {
                    endTurnWithoutResult();
                } else {
                    logger.debug(`[claudeRemote] session_state_changed ${sessionState}: ${verdict}`);
                }
            }

            // Handle special system messages
            if (message.type === 'system' && message.subtype === 'init') {
                // Start thinking when session initializes
                updateThinking(true);
                // B-631: the CLI announced the turn; only an announced turn can
                // be ended by an idle (claudeTurnEnd.ts).
                turn.announced();

                const systemInit = message as SDKSystemMessage;
                // B-631: feature-detect what this Claude Code can do (interrupt
                // receipts, cancel_queued, command lifecycle frames).
                cliCapabilities = new Set(Array.isArray(systemInit.capabilities) ? systemInit.capabilities : []);

                // Session id is still in memory, wait until session file is written to disk
                // Start a watcher for to detect the session id
                // Emit SDK metadata (tools, slash commands) from init message
                if (opts.onSDKMetadata) {
                    opts.onSDKMetadata({
                        models,
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
                // B-631: false when an idle already ended this turn — the web has
                // its turn-end and the next message is being pulled; the
                // lifecycle below is not repeated for it.
                const endsTurn = turn.onResult();
                updateThinking(false);
                logger.debug(endsTurn ? '[claudeRemote] Result received' : '[claudeRemote] Result received for a turn already ended by idle');
                logger.debug(formatClaudeTimingLine({
                    turn: timingTurn,
                    firstTurnOfProcess: timingTurn === 1,
                    marks: timingMarks,
                    result: message,
                    prewarm: timingTurn === 1 ? prewarmTiming : undefined,
                }));
                timingTurn++;
                timingMarks = {};
                // Authoritative record of tools Claude Code denied without a
                // prompt (deny rules, dontAsk/auto, hook denies). Invisible
                // otherwise — surface it so "yolo still refused X" is diagnosable.
                const denials = (message as { permission_denials?: Array<{ tool_name?: string }> }).permission_denials;
                if (denials && denials.length > 0) {
                    logger.warn(`[claudeRemote] ${denials.length} tool call(s) auto-denied by Claude Code policy: ${denials.map((d) => d.tool_name ?? '?').join(', ')}`);
                }

                // Send completion messages
                if (isCompactCommand) {
                    const outcome = compactOutcomeEvent(message, compactStatus);
                    logger.debug(`[claudeRemote] ${outcome}`);
                    opts.onCompletionEvent?.(outcome);
                    isCompactCommand = false;
                    compactStatus = null;
                }

                // Send ready event
                if (endsTurn) opts.onReady(message);
                if (recycleIfPoisoned(message)) continue;
                if (endsTurn) pullNextMessage();
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
        // B-634 ②: whatever the Query ended on (a crash, a teardown), a
        // message Claude Code never started is not answered — say so. Only a
        // CLI that emits lifecycle frames can confirm at all; without them
        // every message would look unconfirmed.
        if (cliCapabilities.has(MSG_LIFECYCLE_CAPABILITY)) {
            const unconfirmed = commandTracker.takeUnconfirmed();
            if (unconfirmed.length > 0) {
                logger.debug(`[claudeRemote] Query ended with ${unconfirmed.length} user message(s) never started: ${unconfirmed.map((c) => c.uuid).join(', ')}`);
                opts.onCommandsUnconfirmed?.(unconfirmed, { aborted: opts.signal?.aborted === true });
            }
        }
    }
}
