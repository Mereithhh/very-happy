/**
 * Permission Handler for canCallTool integration
 *
 * Uses official SDK's toolUseID from canUseTool callback options.
 * Handles tool permission requests, responses, and state management.
 */

import { logger } from "@/lib";
import type {
    CanUseTool,
    ElicitationRequest,
    ElicitationResult,
    PermissionResult,
    PermissionUpdate,
    UserDialogRequest,
    UserDialogResult,
} from "../sdk/types";
import { Session } from "../session";
import { EnhancedMode, PermissionMode } from "../loop";
import { getToolDescriptor } from "./getToolDescriptor";
import { contentLogMetadata } from '@/utils/contentLogMetadata';

interface PermissionResponse {
    id: string;
    approved: boolean;
    reason?: string;
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    allowTools?: string[];
    updatedInput?: Record<string, unknown>;
    receivedAt?: number;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
}

interface PendingRequestBase {
    kind: 'tool' | 'elicitation' | 'user_dialog';
    reject: (error: Error) => void;
}

interface PendingToolRequest extends PendingRequestBase {
    kind: 'tool';
    resolve: (value: PermissionResult) => void;
    toolName: string;
    input: unknown;
    suggestions?: PermissionUpdate[];
}

interface PendingElicitationRequest extends PendingRequestBase {
    kind: 'elicitation';
    resolve: (value: ElicitationResult) => void;
    request: ElicitationRequest;
}

interface PendingUserDialogRequest extends PendingRequestBase {
    kind: 'user_dialog';
    resolve: (value: UserDialogResult) => void;
    request: UserDialogRequest;
}

type PendingRequest = PendingToolRequest | PendingElicitationRequest | PendingUserDialogRequest;

function elicitationContent(input?: Record<string, unknown>): Record<string, string | number | boolean | string[]> | undefined {
    if (!input) return undefined;
    const content: Record<string, string | number | boolean | string[]> = {};
    for (const [key, value] of Object.entries(input)) {
        if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean'
            || (Array.isArray(value) && value.every((item) => typeof item === 'string'))) {
            content[key] = value as string | number | boolean | string[];
        }
    }
    return content;
}

export class PermissionHandler {
    private responses = new Map<string, PermissionResponse>();
    private pendingRequests = new Map<string, PendingRequest>();
    private session: Session;
    private allowedTools = new Set<string>();
    private allowedBashLiterals = new Set<string>();
    private allowedBashPrefixes = new Set<string>();
    private permissionMode: PermissionMode = 'default';
    private onPermissionRequestCallback?: (toolCallId: string) => void;
    /** Callback to change permission mode on the active query (set by claudeRemote) */
    private setPermissionModeCallback?: (mode: PermissionMode) => Promise<void>;

    constructor(session: Session) {
        this.session = session;
        this.setupClientHandler();
    }

    /**
     * Set callback to trigger when permission request is made
     */
    setOnPermissionRequest(callback: (toolCallId: string) => void) {
        this.onPermissionRequestCallback = callback;
    }

    handleModeChange(mode: PermissionMode) {
        this.permissionMode = mode;
    }

    /**
     * Set callback to dynamically change permission mode on the active query.
     * Called by claudeRemote after the Query object is created.
     */
    setPermissionModeUpdater(callback: (mode: PermissionMode) => Promise<void>) {
        this.setPermissionModeCallback = callback;
    }

    /**
     * Handler response
     */
    private async handlePermissionResponse(
        response: PermissionResponse,
        pending: PendingToolRequest
    ): Promise<PermissionResponse> {

        // Handle
        if (pending.toolName === 'exit_plan_mode' || pending.toolName === 'ExitPlanMode') {
            logger.debug('Plan mode result received', {
                approved: response.approved,
                mode: response.mode,
                reason: contentLogMetadata(response.reason),
                allowToolCount: response.allowTools?.length ?? 0,
                updatedInput: contentLogMetadata(response.updatedInput),
            });
            if (response.approved) {
                // Switch permission mode via SDK before allowing ExitPlanMode
                const newMode = (response.mode && ['default', 'acceptEdits', 'bypassPermissions'].includes(response.mode))
                    ? response.mode
                    : 'default';

                logger.debug(`Plan approved - switching to ${newMode} mode and allowing ExitPlanMode`);

                try {
                    if (!this.setPermissionModeCallback) throw new Error('permission mode updater unavailable');
                    await this.setPermissionModeCallback(newMode);
                } catch (err) {
                    const reason = `Failed to switch permission mode: ${err instanceof Error ? err.message : String(err)}`;
                    logger.debug(reason);
                    pending.resolve({ behavior: 'deny', message: reason });
                    return { ...response, approved: false, reason };
                }
                this.permissionMode = newMode;

                pending.resolve({ behavior: 'allow', updatedInput: (pending.input as Record<string, unknown>) || {} });
            } else {
                pending.resolve({ behavior: 'deny', message: response.reason || 'Plan rejected' });
            }
        } else {
            if (response.approved && response.mode) {
                try {
                    if (!this.setPermissionModeCallback) throw new Error('permission mode updater unavailable');
                    await this.setPermissionModeCallback(response.mode);
                    this.permissionMode = response.mode;
                } catch (err) {
                    const reason = `Failed to switch permission mode: ${err instanceof Error ? err.message : String(err)}`;
                    pending.resolve({ behavior: 'deny', message: reason });
                    return { ...response, approved: false, reason };
                }
            }

            // Legacy clients may still send allowTools. Apply them only after
            // all other approval side effects have succeeded. Prefer the
            // SDK-authored suggestions whenever available because they
            // preserve rule scope.
            if (response.approved && !pending.suggestions?.length && response.allowTools?.length) {
                response.allowTools.forEach((tool) => {
                    if (tool.startsWith('Bash(') || tool === 'Bash') {
                        this.parseBashPermission(tool);
                    } else {
                        this.allowedTools.add(tool);
                    }
                });
            }

            // Handle default case for all other tools
            const originalInput = (pending.input as Record<string, unknown>) || {};
            const updatedInput = response.updatedInput
                ? { ...originalInput, ...response.updatedInput }
                : originalInput;
            const result: PermissionResult = response.approved
                ? {
                    behavior: 'allow',
                    updatedInput,
                    ...(response.decision === 'approved_for_session' && pending.suggestions?.length
                        ? { updatedPermissions: pending.suggestions }
                        : {}),
                }
                : { behavior: 'deny', message: response.reason || `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.` };

            pending.resolve(result);
        }
        return response;
    }

    /**
     * Creates the canCallTool callback for the SDK.
     * Uses toolUseID from official SDK callback options directly.
     */
    handleToolCall = async (toolName: string, input: unknown, mode: EnhancedMode, options: Parameters<CanUseTool>[2]): Promise<PermissionResult> => {
        const toolCallId = options.toolUseID;

        // AskUserQuestion requires user interaction — never auto-approve, even in bypassPermissions mode.
        // This mirrors Claude SDK's internal requiresUserInteraction() check.
        if (toolName === 'AskUserQuestion') {
            return this.handlePermissionRequest(toolCallId, toolName, input, options.signal, options.suggestions);
        }

        // Check if tool is explicitly allowed
        if (toolName === 'Bash') {
            const inputObj = input as { command?: string };
            if (inputObj?.command) {
                // Check literal matches
                if (this.allowedBashLiterals.has(inputObj.command)) {
                    return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
                }
                // Check prefix matches
                for (const prefix of this.allowedBashPrefixes) {
                    if (inputObj.command.startsWith(prefix)) {
                        return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
                    }
                }
            }
        } else if (this.allowedTools.has(toolName)) {
            return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
        }

        // Calculate descriptor
        const descriptor = getToolDescriptor(toolName);

        // ExitPlanMode always requires user approval — never auto-approve it.
        if (descriptor.exitPlan) {
            return this.handlePermissionRequest(toolCallId, toolName, input, options.signal, options.suggestions);
        }

        //
        // Handle special cases
        //

        if (this.permissionMode === 'bypassPermissions') {
            return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
        }

        if (this.permissionMode === 'acceptEdits' && descriptor.edit) {
            return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
        }

        // Plan mode: auto-approve read-only tools (Read, Glob, Grep, etc.)
        // Dangerous tools (Bash, Edit, Write) still require approval
        if (this.permissionMode === 'plan' && !descriptor.dangerous) {
            return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
        }

        //
        // Approval flow
        //

        return this.handlePermissionRequest(toolCallId, toolName, input, options.signal, options.suggestions);
    }

    /**
     * Handles individual permission requests
     */
    private async handlePermissionRequest(
        id: string,
        toolName: string,
        input: unknown,
        signal: AbortSignal,
        suggestions?: PermissionUpdate[]
    ): Promise<PermissionResult> {
        return new Promise<PermissionResult>((resolve, reject) => {
            if (signal.aborted) {
                reject(new Error('Permission request aborted', { cause: signal.reason }));
                return;
            }
            // Set up abort signal handling
            const abortHandler = () => {
                this.pendingRequests.delete(id);
                this.cancelRequestInAgentState(id, 'Permission request aborted');
                reject(new Error('Permission request aborted'));
            };
            signal.addEventListener('abort', abortHandler, { once: true });

            // Store the pending request
            this.pendingRequests.set(id, {
                kind: 'tool',
                resolve: (result: PermissionResult) => {
                    signal.removeEventListener('abort', abortHandler);
                    resolve(result);
                },
                reject: (error: Error) => {
                    signal.removeEventListener('abort', abortHandler);
                    reject(error);
                },
                toolName,
                input,
                suggestions,
            });

            // Trigger callback to send delayed messages immediately
            if (this.onPermissionRequestCallback) {
                this.onPermissionRequestCallback(id);
            }

            // Send push notification
            this.session.api.push().sendSessionNotification({
                kind: 'permission',
                metadata: this.session.client.getMetadata(),
                data: {
                    sessionId: this.session.client.sessionId,
                    requestId: id,
                    tool: toolName,
                    type: 'permission_request',
                    provider: 'claude',
                }
            });

            // Update agent state
            this.session.client.updateAgentState((currentState) => ({
                ...currentState,
                requests: {
                    ...currentState.requests,
                    [id]: {
                        tool: toolName,
                        arguments: input,
                        createdAt: Date.now(),
                        kind: 'tool',
                        ...(suggestions?.length ? { permissionSuggestions: suggestions } : {}),
                    }
                }
            }));

            // Account-encrypted feed notification (best-effort).
            this.session.notificationProducer?.permissionRequest(toolName);

            // B-069 主动汇报: assistant-dispatched sessions also report the
            // →needs_input transition to the local daemon (best-effort no-op
            // for ordinary sessions — see Session.reportEventToDaemon).
            this.session.reportEventToDaemon('needs_input');

            logger.debug(`Permission request sent for tool call ${id}: ${toolName}`);
        });
    }

    handleElicitation = async (
        request: ElicitationRequest,
        options: { signal: AbortSignal; requestId: string },
    ): Promise<ElicitationResult> => {
        return this.handleInteractionRequest(options.requestId, 'elicitation', request, options.signal);
    };

    handleUserDialog = async (
        request: UserDialogRequest,
        options: { signal: AbortSignal; requestId: string },
    ): Promise<UserDialogResult> => {
        // The SDK explicitly requires unknown open-union kinds to fail closed.
        if (request.dialogKind !== 'refusal_fallback_prompt') {
            return { behavior: 'cancelled' };
        }
        return this.handleInteractionRequest(options.requestId, 'user_dialog', request, options.signal);
    };

    private handleInteractionRequest(
        id: string,
        kind: 'elicitation',
        request: ElicitationRequest,
        signal: AbortSignal,
    ): Promise<ElicitationResult>;
    private handleInteractionRequest(
        id: string,
        kind: 'user_dialog',
        request: UserDialogRequest,
        signal: AbortSignal,
    ): Promise<UserDialogResult>;
    private handleInteractionRequest(
        id: string,
        kind: 'elicitation' | 'user_dialog',
        request: ElicitationRequest | UserDialogRequest,
        signal: AbortSignal,
    ): Promise<ElicitationResult | UserDialogResult> {
        return new Promise((resolve, reject) => {
            if (signal.aborted) {
                reject(new Error('Interaction request aborted', { cause: signal.reason }));
                return;
            }
            const abortHandler = () => {
                this.pendingRequests.delete(id);
                this.cancelRequestInAgentState(id, 'Interaction request aborted');
                reject(new Error('Interaction request aborted', { cause: signal.reason }));
            };
            signal.addEventListener('abort', abortHandler, { once: true });

            const finishResolve = (value: ElicitationResult | UserDialogResult) => {
                signal.removeEventListener('abort', abortHandler);
                resolve(value);
            };
            const finishReject = (error: Error) => {
                signal.removeEventListener('abort', abortHandler);
                reject(error);
            };
            if (kind === 'elicitation') {
                this.pendingRequests.set(id, {
                    kind,
                    request: request as ElicitationRequest,
                    resolve: finishResolve as (value: ElicitationResult) => void,
                    reject: finishReject,
                });
            } else {
                this.pendingRequests.set(id, {
                    kind,
                    request: request as UserDialogRequest,
                    resolve: finishResolve as (value: UserDialogResult) => void,
                    reject: finishReject,
                });
            }

            const tool = kind === 'elicitation' ? 'McpElicitation' : 'ClaudeUserDialog';
            this.publishRequest(id, tool, request, kind);
        });
    }

    private publishRequest(
        id: string,
        tool: string,
        args: unknown,
        kind: 'elicitation' | 'user_dialog',
    ): void {
        this.session.api.push().sendSessionNotification({
            kind: 'permission',
            metadata: this.session.client.getMetadata(),
            data: {
                sessionId: this.session.client.sessionId,
                requestId: id,
                tool,
                type: 'permission_request',
                provider: 'claude',
            },
        });
        this.session.client.updateAgentState((currentState) => ({
            ...currentState,
            requests: {
                ...currentState.requests,
                [id]: { tool, arguments: args, createdAt: Date.now(), kind },
            },
        }));
        this.session.notificationProducer?.permissionRequest(tool);
        this.session.reportEventToDaemon('needs_input');
        logger.debug(`${kind} request sent: ${id}`);
    }

    private cancelRequestInAgentState(id: string, reason: string): void {
        this.session.client.updateAgentState((currentState) => {
            const request = currentState.requests?.[id];
            if (!request) return currentState;
            const requests = { ...currentState.requests };
            delete requests[id];
            return {
                ...currentState,
                requests,
                completedRequests: {
                    ...currentState.completedRequests,
                    [id]: {
                        ...request,
                        completedAt: Date.now(),
                        status: 'canceled',
                        reason,
                    },
                },
            };
        });
    }


    /**
     * Parses Bash permission strings into literal and prefix sets
     */
    private parseBashPermission(permission: string): void {
        // Ignore plain "Bash"
        if (permission === 'Bash') {
            return;
        }

        // Match Bash(command) or Bash(command:*)
        const bashPattern = /^Bash\((.+?)\)$/;
        const match = permission.match(bashPattern);

        if (!match) {
            return;
        }

        const command = match[1];

        // Check if it's a prefix pattern (ends with :*)
        if (command.endsWith(':*')) {
            const prefix = command.slice(0, -2); // Remove :*
            this.allowedBashPrefixes.add(prefix);
        } else {
            // Literal match
            this.allowedBashLiterals.add(command);
        }
    }

    /**
     * Checks if a tool call is rejected
     */
    isAborted(toolCallId: string): boolean {
        // If tool not approved, it's aborted
        if (this.responses.get(toolCallId)?.approved === false) {
            return true;
        }

        // Tool call is not aborted
        return false;
    }

    /**
     * Resets all state for new sessions
     */
    reset(reason: string = 'Session switched to local mode'): void {
        this.responses.clear();
        this.allowedTools.clear();
        this.allowedBashLiterals.clear();
        this.allowedBashPrefixes.clear();
        this.permissionMode = 'default';

        // Cancel all pending requests
        for (const [, pending] of this.pendingRequests.entries()) {
            pending.reject(new Error('Session reset'));
        }
        this.pendingRequests.clear();

        // Move all pending requests to completedRequests with canceled status
        this.session.client.updateAgentState((currentState) => {
            const pendingRequests = currentState.requests || {};
            const completedRequests = { ...currentState.completedRequests };

            // Move each pending request to completed with canceled status
            for (const [id, request] of Object.entries(pendingRequests)) {
                completedRequests[id] = {
                    ...request,
                    completedAt: Date.now(),
                    status: 'canceled',
                    reason
                };
            }

            return {
                ...currentState,
                requests: {}, // Clear all pending requests
                completedRequests
            };
        });
    }

    /**
     * Sets up the client handler for permission responses
     */
    private setupClientHandler(): void {
        this.session.client.rpcHandlerManager.registerHandler<PermissionResponse, void>('permission', async (message) => {
            logger.debug('Permission response received:', {
                id: message.id,
                approved: message.approved,
                mode: message.mode,
                reason: contentLogMetadata(message.reason),
                allowToolCount: message.allowTools?.length ?? 0,
                updatedInput: contentLogMetadata(message.updatedInput),
            });

            const id = message.id;
            const pending = this.pendingRequests.get(id);

            if (!pending) {
                logger.debug('Permission request not found or already resolved');
                return;
            }

            this.pendingRequests.delete(id);

            let effectiveResponse = message;
            if (pending.kind === 'tool') {
                effectiveResponse = await this.handlePermissionResponse(message, pending);
                this.responses.set(id, { ...effectiveResponse, receivedAt: Date.now() });
            } else if (pending.kind === 'elicitation') {
                pending.resolve(message.approved
                    ? { action: 'accept', content: elicitationContent(message.updatedInput) }
                    : { action: message.decision === 'abort' ? 'cancel' : 'decline' });
            } else {
                pending.resolve(message.approved
                    ? { behavior: 'completed', result: message.updatedInput?.result ?? 'retry_fallback' }
                    : { behavior: 'cancelled' });
            }

            // Move processed request to completedRequests
            this.session.client.updateAgentState((currentState) => {
                const request = currentState.requests?.[id];
                if (!request) return currentState;
                let r = { ...currentState.requests };
                delete r[id];
                return {
                    ...currentState,
                    requests: r,
                    completedRequests: {
                        ...currentState.completedRequests,
                        [id]: {
                            ...request,
                            completedAt: Date.now(),
                            status: effectiveResponse.approved ? 'approved' : 'denied',
                            reason: effectiveResponse.reason,
                            mode: effectiveResponse.mode,
                            decision: effectiveResponse.decision,
                            allowedTools: effectiveResponse.allowTools
                        }
                    }
                };
            });
        });
    }

    /**
     * Gets the responses map (for compatibility with existing code)
     */
    getResponses(): Map<string, PermissionResponse> {
        return this.responses;
    }
}
