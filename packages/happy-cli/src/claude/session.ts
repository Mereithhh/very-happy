import { ApiClient, ApiSessionClient } from "@/lib";
import { MessageQueue2 } from "@/utils/MessageQueue2";
import { EnhancedMode } from "./loop";
import { logger } from "@/ui/logger";
import type { JsRuntime } from "./runClaude";
import type { SandboxConfig } from "@/persistence";
import { NotificationProducer } from "./notificationProducer";

export class Session {
    readonly path: string;
    readonly logPath: string;
    readonly api: ApiClient;
    readonly client: ApiSessionClient;
    readonly queue: MessageQueue2<EnhancedMode>;
    readonly claudeEnvVars?: Record<string, string>;
    claudeArgs?: string[];  // Made mutable to allow filtering
    readonly mcpServers: Record<string, any>;
    readonly allowedTools?: string[];
    readonly sandboxConfig?: SandboxConfig;
    readonly _onModeChange: (mode: 'local' | 'remote') => void;
    readonly _onAbort?: () => void;
    /** Path to temporary settings file with SessionStart hook (required for session tracking) */
    readonly hookSettingsPath: string;
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    readonly jsRuntime: JsRuntime;

    sessionId: string | null;
    mode: 'local' | 'remote' = 'local';
    thinking: boolean = false;

    /**
     * Account-encrypted notification producer. Set lazily once we have a
     * server session id (notifications are addressed per session). May be
     * null in offline/degraded paths — all call sites must null-check.
     */
    notificationProducer: NotificationProducer | null = null;

    /**
     * Whether Claude produced assistant text output during the current turn.
     * Used at turn end to distinguish `reply_done` (Claude replied) from
     * `input_needed` (turn ended idle without a reply, e.g. after an abort).
     */
    private hadAssistantOutputThisTurn = false;
    /** Last assistant text snippet seen this turn, used as the reply_done body. */
    private lastAssistantSnippet: string | undefined;

    /** Callbacks to be notified when session ID is found/changed */
    private sessionFoundCallbacks: ((sessionId: string) => void)[] = [];
    
    /** Keep alive interval reference for cleanup */
    private keepAliveInterval: NodeJS.Timeout;

    constructor(opts: {
        api: ApiClient,
        client: ApiSessionClient,
        path: string,
        logPath: string,
        sessionId: string | null,
        claudeEnvVars?: Record<string, string>,
        claudeArgs?: string[],
        mcpServers: Record<string, any>,
        messageQueue: MessageQueue2<EnhancedMode>,
        onModeChange: (mode: 'local' | 'remote') => void,
        onAbort?: () => void,
        allowedTools?: string[],
        sandboxConfig?: SandboxConfig,
        /** Path to temporary settings file with SessionStart hook (required for session tracking) */
        hookSettingsPath: string,
        /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
        jsRuntime?: JsRuntime,
    }) {
        this.path = opts.path;
        this.api = opts.api;
        this.client = opts.client;
        this.logPath = opts.logPath;
        this.sessionId = opts.sessionId;
        this.queue = opts.messageQueue;
        this.claudeEnvVars = opts.claudeEnvVars;
        this.claudeArgs = opts.claudeArgs;
        this.mcpServers = opts.mcpServers;
        this.allowedTools = opts.allowedTools;
        this.sandboxConfig = opts.sandboxConfig;
        this._onModeChange = opts.onModeChange;
        this._onAbort = opts.onAbort;
        this.hookSettingsPath = opts.hookSettingsPath;
        this.jsRuntime = opts.jsRuntime ?? 'node';

        // Set up the account-encrypted notification producer. Bound to the
        // server session id (client.sessionId) — the id notifications reference
        // and that the app uses to route a notification back to its session.
        try {
            this.notificationProducer = opts.api.notificationProducer(
                opts.client.sessionId,
                () => opts.client.getMetadata(),
            );
        } catch (err) {
            // Never let notification setup break a session.
            logger.debug('[Session] Failed to create notification producer:', err);
            this.notificationProducer = null;
        }

        // Start keep alive
        this.client.keepAlive(this.thinking, this.mode);
        this.keepAliveInterval = setInterval(() => {
            this.client.keepAlive(this.thinking, this.mode);
        }, 2000);
    }
    
    /**
     * Cleanup resources (call when session is no longer needed)
     */
    cleanup = (): void => {
        clearInterval(this.keepAliveInterval);
        this.sessionFoundCallbacks = [];
        logger.debug('[Session] Cleaned up resources');
    }

    onThinkingChange = (thinking: boolean) => {
        // A fresh thinking phase begins a new turn — reset per-turn tracking so
        // turn-end can correctly classify reply_done vs input_needed.
        if (thinking && !this.thinking) {
            this.hadAssistantOutputThisTurn = false;
            this.lastAssistantSnippet = undefined;
        }
        this.thinking = thinking;
        this.client.keepAlive(thinking, this.mode);
    }

    /**
     * Record that Claude emitted an assistant text reply during this turn.
     * Called from the message stream so turn-end can fire `reply_done` with a
     * meaningful snippet.
     */
    noteAssistantOutput = (snippet?: string) => {
        this.hadAssistantOutputThisTurn = true;
        if (snippet) {
            this.lastAssistantSnippet = snippet;
        }
    }

    /**
     * A turn has ended (the agent yielded control back, e.g. SDK `result`).
     * Produces the appropriate notification:
     *   - `reply_done` when Claude produced output this turn,
     *   - `input_needed` when the session is now idle awaiting user input
     *     (not controlled by user, no pending permission requests, not thinking).
     *
     * `idle` is true when there are no pending/queued messages — the producer
     * caller (launcher) knows this. The pending-requests / controlledByUser
     * checks are made here against the latest agent state.
     */
    onTurnEnd = (idle: boolean) => {
        const producer = this.notificationProducer;
        if (!producer) return;

        if (this.hadAssistantOutputThisTurn) {
            producer.replyDone(this.lastAssistantSnippet);
            this.hadAssistantOutputThisTurn = false;
            this.lastAssistantSnippet = undefined;
            return;
        }

        if (!idle) {
            // More work queued — not actually waiting on the user.
            return;
        }

        const state = this.client.getAgentState();
        const hasPendingRequests = !!state?.requests && Object.keys(state.requests).length > 0;
        const controlledByUser = state?.controlledByUser === true;
        if (!hasPendingRequests && !controlledByUser && !this.thinking) {
            producer.inputNeeded();
        }
    }

    /** Produce an `error` notification for an unexpected session failure. */
    onSessionError = (message?: string) => {
        this.notificationProducer?.error(message);
    }

    onModeChange = (mode: 'local' | 'remote') => {
        this.mode = mode;
        this.client.keepAlive(this.thinking, mode);
        this._onModeChange(mode);
    }

    onAbort = () => {
        this._onAbort?.();
    }

    /**
     * Called when Claude session ID is discovered or changed.
     * 
     * This is triggered by the SessionStart hook when:
     * - Claude starts a new session (fresh start)
     * - Claude resumes a session (--continue, --resume flags)
     * - Claude forks a session (/compact, double-escape fork)
     * 
     * Updates internal state, syncs to API metadata, and notifies
     * all registered callbacks (e.g., SessionScanner) about the change.
     */
    onSessionFound = (sessionId: string) => {
        this.sessionId = sessionId;
        
        // Update metadata with Claude Code session ID
        this.client.updateMetadata((metadata) => ({
            ...metadata,
            claudeSessionId: sessionId
        }));
        logger.debug(`[Session] Claude Code session ID ${sessionId} added to metadata`);
        
        // Notify all registered callbacks
        for (const callback of this.sessionFoundCallbacks) {
            callback(sessionId);
        }
    }
    
    /**
     * Register a callback to be notified when session ID is found/changed
     */
    addSessionFoundCallback = (callback: (sessionId: string) => void): void => {
        this.sessionFoundCallbacks.push(callback);
    }
    
    /**
     * Remove a session found callback
     */
    removeSessionFoundCallback = (callback: (sessionId: string) => void): void => {
        const index = this.sessionFoundCallbacks.indexOf(callback);
        if (index !== -1) {
            this.sessionFoundCallbacks.splice(index, 1);
        }
    }

    /**
     * Clear the current session ID (used by /clear command)
     */
    clearSessionId = (): void => {
        this.sessionId = null;
        logger.debug('[Session] Session ID cleared');
    }

    /**
     * Consume one-time Claude flags from claudeArgs after Claude spawn
     * Handles: --resume (with or without session ID), --continue
     */
    consumeOneTimeFlags = (): void => {
        if (!this.claudeArgs) return;
        
        const filteredArgs: string[] = [];
        for (let i = 0; i < this.claudeArgs.length; i++) {
            const arg = this.claudeArgs[i];
            
            if (arg === '--continue') {
                logger.debug('[Session] Consumed --continue flag');
                continue;
            }
            
            if (arg === '--resume') {
                // Check if next arg looks like a UUID (contains dashes and alphanumeric)
                if (i + 1 < this.claudeArgs.length) {
                    const nextArg = this.claudeArgs[i + 1];
                    // Simple UUID pattern check - contains dashes and is not another flag
                    if (!nextArg.startsWith('-') && nextArg.includes('-')) {
                        // Skip both --resume and the UUID
                        i++; // Skip the UUID
                        logger.debug(`[Session] Consumed --resume flag with session ID: ${nextArg}`);
                    } else {
                        // Just --resume without UUID
                        logger.debug('[Session] Consumed --resume flag (no session ID)');
                    }
                } else {
                    // --resume at the end of args
                    logger.debug('[Session] Consumed --resume flag (no session ID)');
                }
                continue;
            }
            
            filteredArgs.push(arg);
        }
        
        this.claudeArgs = filteredArgs.length > 0 ? filteredArgs : undefined;
        logger.debug(`[Session] Consumed one-time flags, remaining args:`, this.claudeArgs);
    }
}
