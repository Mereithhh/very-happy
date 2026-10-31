/**
 * Codex App Server Client — drives Codex via the v2 JSON-RPC protocol
 * (`codex app-server`), replacing the legacy MCP-based CodexMcpClient.
 *
 * Protocol: JSON-RPC 2.0 over stdio (newline-delimited JSON).
 * Reference: codex-rs/app-server/README.md in the openai/codex repo.
 *
 * WARNING: @openai/codex-sdk (v0.118.0) exists but only wraps `codex exec`
 * (non-interactive, fire-and-forget). It has NO support for `app-server`,
 * interactive approvals, or bidirectional JSON-RPC. We need app-server for
 * mobile approval routing (exec:request, patch:request, mcp:call), which is
 * why this client is hand-rolled. Re-evaluate if the SDK ever adds an
 * app-server wrapper or approval callbacks. See docs/plans/codex-app-server-migration.md.
 */

import { execSync, type ChildProcess } from 'node:child_process';
import { spawn as crossSpawn } from 'cross-spawn';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { logger } from '@/ui/logger';
import { contentLogMetadata, errorLogMetadata } from '@/utils/contentLogMetadata';
import type {
    CodexModel,
    InitializeParams,
    NewConversationParams,
    NewConversationResponse,
    ResumeConversationParams,
    ResumeConversationResponse,
    ForkConversationParams,
    ForkConversationResponse,
    ReadConversationParams,
    ReadConversationResponse,
    RollbackConversationParams,
    RollbackConversationResponse,
    InjectItemsParams,
    InjectItemsResponse,
    Thread,
    InterruptConversationParams,
    ReviewDecision,
    EventMsg,
    JsonRpcRequest,
    JsonRpcResponse,
    ApprovalPolicy,
    SandboxMode,
    InputItem,
    ReasoningEffort,
    McpServerElicitationRequestResponse,
    InitializeResponse,
} from './codexAppServerTypes';
import type { SandboxConfig } from '@/persistence';
import { initializeSandbox, wrapForMcpTransport } from '@/sandbox/manager';
import packageJson from '../../package.json';
import { isUnsupportedCodexMethodError, shouldReadCodexRateLimits } from '@/rateLimits/rateLimitWindows';
import { codexChildAnnouncements } from './codexChildThreads';
import { killCodexProcessTree, stopCodexProcess } from './codexProcessTree';

/** JSON-RPC error code carried by a rejected `request()`, when Codex answered with one. */
export function jsonRpcErrorCodeOf(error: unknown): number | null {
    const code = (error as { jsonRpcCode?: unknown } | null)?.jsonRpcCode;
    return typeof code === 'number' ? code : null;
}

/** B-628: why `steerTurn` did not steer, for the caller to queue the message instead. */
export type CodexSteerOutcome = 'steered' | 'no-turn' | 'unsupported' | 'refused' | 'failed';

type PendingRequest = {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    method: string;
    epoch: number;
};

type LegacyPatchChanges = Record<string, Record<string, unknown>>;

export type ApprovalHandler = (params: {
    type: 'exec' | 'patch' | 'mcp';
    callId: string;
    command?: string[];
    cwd?: string;
    fileChanges?: Record<string, unknown>;
    reason?: string | null;
    toolName?: string;
    input?: unknown;
    serverName?: string;
    message?: string;
}) => Promise<ReviewDecision>;

/**
 * Check that `codex app-server` is available.
 */
/** B-844d: the thread's model from a thread/start|resume|fork response (top-level, else thread.model). */
export function threadModelOf(result: { model?: unknown; thread?: object } | null | undefined): string | null {
    const model = result?.model ?? (result?.thread as { model?: unknown } | undefined)?.model;
    return typeof model === 'string' && model.trim() ? model.trim() : null;
}

function isAppServerAvailable(): boolean {
    try {
        const version = execSync('codex --version', { encoding: 'utf8', windowsHide: true }).trim();
        const match = version.match(/codex-cli\s+(\d+\.\d+\.\d+)/);
        if (!match) return false;
        const [, ver] = match;
        const [major, minor] = ver.split('.').map(Number);
        // app-server available in recent versions
        return major > 0 || minor >= 100;
    } catch {
        return false;
    }
}

function normalizeRawFileChangeList(changes: unknown): LegacyPatchChanges | undefined {
    if (!Array.isArray(changes)) {
        return undefined;
    }

    const normalized: LegacyPatchChanges = {};
    for (const change of changes) {
        if (!change || typeof change !== 'object' || Array.isArray(change)) {
            continue;
        }

        const path = typeof change.path === 'string' ? change.path : null;
        if (!path) {
            continue;
        }

        const entry: Record<string, unknown> = {};
        const changeRecord = change as Record<string, unknown>;
        const kind = changeRecord.kind && typeof changeRecord.kind === 'object' && !Array.isArray(changeRecord.kind)
            ? changeRecord.kind as Record<string, unknown>
            : null;
        const type = typeof changeRecord.type === 'string'
            ? changeRecord.type
            : (typeof kind?.type === 'string' ? kind.type : null);
        const movePath = changeRecord.move_path ?? kind?.move_path ?? null;

        if (kind) {
            entry.kind = kind;
        } else if (type) {
            entry.kind = { type, move_path: movePath };
        }

        const diff = typeof changeRecord.diff === 'string'
            ? changeRecord.diff
            : (typeof changeRecord.unified_diff === 'string' ? changeRecord.unified_diff : null);
        if (diff !== null) {
            entry.diff = diff;
        }

        if (changeRecord.add && typeof changeRecord.add === 'object' && !Array.isArray(changeRecord.add)) {
            entry.add = changeRecord.add;
        }
        if (changeRecord.modify && typeof changeRecord.modify === 'object' && !Array.isArray(changeRecord.modify)) {
            entry.modify = changeRecord.modify;
        }
        if (changeRecord.delete && typeof changeRecord.delete === 'object' && !Array.isArray(changeRecord.delete)) {
            entry.delete = changeRecord.delete;
        }

        const content = typeof changeRecord.content === 'string' ? changeRecord.content : null;
        if (type === 'add' && content !== null) {
            entry.add = { content };
        }
        if (type === 'delete' && content !== null) {
            entry.delete = { content };
        }

        const oldContent = typeof changeRecord.oldContent === 'string'
            ? changeRecord.oldContent
            : (typeof changeRecord.old_content === 'string' ? changeRecord.old_content : null);
        const newContent = typeof changeRecord.newContent === 'string'
            ? changeRecord.newContent
            : (typeof changeRecord.new_content === 'string' ? changeRecord.new_content : null);
        if ((oldContent !== null || newContent !== null) && type !== 'add' && type !== 'delete') {
            entry.modify = {
                old_content: oldContent ?? '',
                new_content: newContent ?? '',
            };
        }

        normalized[path] = entry;
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export class CodexAppServerClient {
    private process: ChildProcess | null = null;
    private readline: ReadlineInterface | null = null;
    private nextId = 1;
    private pending = new Map<number, PendingRequest>();
    private processEpoch = 0;
    private connected = false;
    /** B-852: agent version from the last `initialize` (null = unknown). */
    serverVersion: string | null = null;
    private sandboxConfig?: SandboxConfig;
    private sandboxCleanup: (() => Promise<void>) | null = null;
    public sandboxEnabled = false;

    // Session state
    private _threadId: string | null = null;
    private _turnId: string | null = null;
    /**
     * B-844d: the model the thread really runs. Codex keeps a thread's model
     * (thread/start, thread/resume, a turn/start that named one) for every
     * later turn that omits it, and reports it on start/resume/fork.
     */
    private _threadModel: string | null = null;
    private threadDefaults: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
    } | null = null;

    // Turn completion tracking for the currently active sendTurnAndWait call.
    private pendingTurnCompletion: {
        resolve: (aborted: boolean) => void;
        turnId: string | null;
        /** B-625: Codex reported this turn running (`turn/started` / legacy task_started). */
        opened: boolean;
        /** How long an own-thread idle/systemError waits for Codex's `turn/completed` (see armThreadStopGrace). */
        threadStopGraceMs: number;
    } | null = null;

    // Tracks in-flight interruptTurn() RPCs so sendTurnAndWait can wait for them
    // before starting a new turn (prevents stale turn/interrupt from aborting the next turn).
    private pendingInterrupt: Promise<void> | null = null;
    // In-flight idle release (B-461); ensureConnected() waits for it so a message
    // arriving mid-release cannot spawn a second app-server against a dying one.
    private idleRelease: Promise<boolean> | null = null;
    private notificationProtocol: 'unknown' | 'legacy' | 'raw' = 'unknown';
    private completedTurnIds = new Set<string>();
    /** B-625: turns whose failure has already been forwarded, so a second failed frame is not. */
    private failedTurnIds = new Set<string>();
    /** The turn the last pending completion was resolved for (runTurnAndWait reads its verdict). */
    private lastResolvedTurnId: string | null = null;
    // B-625: the app-server speaks for every thread it hosts — the session's own and the
    // children `spawn_agent` opens — so a lifecycle frame (turn/started, turn/completed,
    // thread/status/changed, error, thread/closed) is the session's only when its `threadId`
    // is ours; a frame naming no thread belongs to the thread it was asked on (Orca's rule,
    // src/main/codex/codex-structured-turn-open-wait.ts). Before this, a child's
    // `turn/completed` ended the parent's turn in the UI and a child's `turn/started`
    // retargeted `turn/interrupt` at the child.
    /** The own thread's last turn-ending `error` (willRetry=false), for a turn end that arrives without a verdict. */
    private lastTurnError: { turnId: string | null; error: unknown } | null = null;
    /** Own thread reported idle/systemError while a turn was pending: Codex's `turn/completed`
     *  follows within a millisecond; this ends the turn if it does not (see armThreadStopGrace). */
    private threadStopGrace: ReturnType<typeof setTimeout> | null = null;
    /** Last few hundred chars of the app-server's stderr: Codex's own last words when it dies. */
    private stderrRing = '';
    private rawFileChangesByItemId = new Map<string, LegacyPatchChanges>();
    // B-622: inactivity watchdog for the pending turn — re-armed by every
    // notification, never a cap on how long a turn may run (see sendTurnAndWait).
    private turnWatchdog: { timer: ReturnType<typeof setTimeout>; timeoutMs: number } | null = null;
    // Approval / elicitation requests we are still answering: a human may take
    // longer than the watchdog to decide, and that is not Codex going silent.
    private inflightServerRequests = 0;
    // B-628: `turn/steer` — a message sent into the running turn (approach from Orca,
    // src/main/codex/codex-structured-turn-start.ts). This app-server has no such
    // method (-32601) until it is respawned; a refusal is per call (the turn it named
    // ended or changed meanwhile, a review/compact turn).
    private steerUnsupported = false;
    /** Steered inputs Codex has not echoed back as a `userMessage` item yet: clientId → turnId. */
    private steeredAwaitingEcho = new Map<string, string>();
    /** Waiters for the pending turn to open (steerTurn); released when it opens or ends. */
    private turnOpenWaiters: Array<() => void> = [];
    /** B-628: the names Codex gave the child threads it spawned (see codexChildThreads.ts). */
    private childThreadLabels = new Map<string, string>();
    private static readonly MAX_CHILD_LABELS = 128;

    // Handlers set by the consumer (runCodex.ts)
    private eventHandler: ((msg: EventMsg) => void) | null = null;
    private approvalHandler: ApprovalHandler | null = null;
    // B-555: subscription rate-limit snapshots (sparse notifications + throttled reads).
    private rateLimitHandler: ((snapshot: unknown) => void) | null = null;
    private rateLimitReadAt = 0;
    private rateLimitReadInFlight = false;
    private rateLimitReadUnsupported = false;

    constructor(sandboxConfig?: SandboxConfig) {
        this.sandboxConfig = sandboxConfig;
    }

    get threadId(): string | null {
        return this._threadId;
    }

    get turnId(): string | null {
        return this._turnId;
    }

    /** B-844d: the model the current thread runs for turns that name none (null = unknown). */
    get threadModel(): string | null {
        return this._threadModel;
    }

    setEventHandler(handler: (msg: EventMsg) => void): void {
        this.eventHandler = handler;
    }

    setApprovalHandler(handler: ApprovalHandler): void {
        this.approvalHandler = handler;
    }

    /**
     * B-555: receive Codex `RateLimitSnapshot`s — from `account/rateLimits/updated`
     * (sparse: null windows mean "not in this update") and from a throttled
     * `account/rateLimits/read` after connect / each finished turn. Codex does
     * the fetch with its own login; we never touch its credentials.
     */
    setRateLimitHandler(handler: (snapshot: unknown) => void): void {
        this.rateLimitHandler = handler;
        this.maybeRefreshRateLimits();
    }

    private maybeRefreshRateLimits(): void {
        if (!this.rateLimitHandler || !this.connected) return;
        if (!shouldReadCodexRateLimits({
            now: Date.now(),
            lastReadAt: this.rateLimitReadAt,
            inFlight: this.rateLimitReadInFlight,
            unsupported: this.rateLimitReadUnsupported,
        })) return;
        this.rateLimitReadAt = Date.now();
        this.rateLimitReadInFlight = true;
        this.request('account/rateLimits/read', {}, 15_000)
            .then((result) => {
                const snapshot = (result as { rateLimits?: unknown } | null)?.rateLimits;
                if (snapshot) this.rateLimitHandler?.(snapshot);
            })
            .catch((error) => {
                if (isUnsupportedCodexMethodError(error)) this.rateLimitReadUnsupported = true;
                logger.debug('[CodexAppServer] account/rateLimits/read failed:', errorLogMetadata(error));
            })
            .finally(() => { this.rateLimitReadInFlight = false; });
    }

    private extractTurnId(params: any): string | null {
        const turnId = params?.turn?.id ?? params?.turnId ?? params?.turn_id ?? null;
        return typeof turnId === 'string' && turnId.length > 0 ? turnId : null;
    }

    private extractTurnStatus(params: any): string | null {
        const status = params?.turn?.status ?? params?.status ?? null;
        return typeof status === 'string' && status.length > 0 ? status : null;
    }

    private extractThreadId(params: any): string | null {
        const threadId = params?.threadId ?? params?.thread_id ?? params?.thread?.id ?? null;
        return typeof threadId === 'string' && threadId.length > 0 ? threadId : null;
    }

    /** B-625: whether a lifecycle frame is about the session's own thread (see the field comment). */
    private isOwnThreadFrame(params: any): boolean {
        const threadId = this.extractThreadId(params);
        return threadId === null || this._threadId === null || threadId === this._threadId;
    }

    /** B-628: the child thread a frame belongs to, or null for the session's own. */
    private childThreadIdOf(params: any): string | null {
        return this.isOwnThreadFrame(params) ? null : this.extractThreadId(params);
    }

    /**
     * B-628: what a child thread's item carries so the mapper files it under the child's
     * card (`subagent` → the session protocol's sub-agent envelope, as a Claude Task's
     * children are) instead of in the main conversation as the session's own work.
     */
    private childItemFields(params: any): { subagent?: string; subagent_label?: string } {
        const child = this.childThreadIdOf(params);
        if (!child) return {};
        const label = this.childThreadLabels.get(child);
        return { subagent: child, ...(label ? { subagent_label: label } : {}) };
    }

    private rememberChildLabels(item: Record<string, unknown>): void {
        for (const { threadId, label } of codexChildAnnouncements(item)) {
            if (!label || this.childThreadLabels.has(threadId)) continue;
            if (this.childThreadLabels.size >= CodexAppServerClient.MAX_CHILD_LABELS) {
                const oldest = this.childThreadLabels.keys().next().value;
                if (oldest !== undefined) this.childThreadLabels.delete(oldest);
            }
            this.childThreadLabels.set(threadId, label);
        }
    }

    /**
     * B-628: steered inputs the ended turn never echoed. `report` = the turn did not complete
     * (interrupted, failed, app-server gone, given up): Codex never read them, tell the runner.
     * A turn that *completed* drains its pending input before it ends (core/src/session/turn.rs),
     * so an unechoed input there is a codex that accepted the steer but echoes no `clientId` —
     * forgotten silently, because a false「not delivered」on a message the model did read would
     * be worse than today's silence.
     */
    private dropUnechoedSteers(turnId: string | null, report: boolean): void {
        const dropped: string[] = [];
        for (const [clientId, steeredTurn] of this.steeredAwaitingEcho) {
            if (turnId === null || steeredTurn === turnId) {
                dropped.push(clientId);
                this.steeredAwaitingEcho.delete(clientId);
            }
        }
        if (dropped.length === 0) return;
        if (!report) {
            logger.debug(`[CodexAppServer] ${dropped.length} steered message(s) completed without an echo; not reported`);
            return;
        }
        this.eventHandler?.({
            type: 'steer_dropped',
            client_ids: dropped,
            ...(turnId ? { turn_id: turnId } : {}),
        });
    }

    /** Codex's last stderr lines, one line, for a message a person reads. */
    stderrTail(): string {
        return this.stderrRing.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim();
    }

    private shouldHandleRawNotification(method: string): boolean {
        const isRawNotification = method === 'thread/started'
            || method === 'turn/started'
            || method === 'turn/completed'
            || method === 'thread/status/changed'
            || method === 'thread/closed'
            || method === 'thread/tokenUsage/updated'
            || method.startsWith('item/');

        if (!isRawNotification) {
            return false;
        }

        if (this.notificationProtocol === 'legacy') {
            return false;
        }

        if (this.notificationProtocol === 'unknown') {
            this.notificationProtocol = 'raw';
        }

        return true;
    }

    private emitRawTurnCompletion(
        turnId: string | null,
        status: string | null,
        error: unknown,
        source: string,
    ): void {
        const aborted = status === 'cancelled' || status === 'canceled' || status === 'aborted' || status === 'interrupted';
        const failed = status === 'failed' || (error !== undefined && error !== null);

        this.clearThreadStopGrace();
        this.tryResolvePendingTurn(aborted, turnId, source);
        this._turnId = null;
        this.maybeRefreshRateLimits();
        if (this.lastTurnError && (!turnId || !this.lastTurnError.turnId || this.lastTurnError.turnId === turnId)) {
            this.lastTurnError = null;
        }

        if (turnId && this.completedTurnIds.has(turnId)) {
            // B-622: one completion per turn — except the frame that carries the
            // failure. Whatever resolved this turn first (a thread-stop grace, a
            // legacy task_complete) said nothing about *why* it ended;
            // `turn/completed` with `status: failed` is the only place the
            // upstream error (a 504 from the model gateway, a rejected model)
            // is reported, and dropping it as a duplicate is how a failed Codex
            // turn ended in silence (Wei FANG 2026-10-18). B-625: the failure
            // itself is forwarded once.
            if (!failed || this.failedTurnIds.has(turnId)) return;
        }
        if (turnId) {
            this.completedTurnIds.add(turnId);
            if (failed) this.failedTurnIds.add(turnId);
        }
        this.dropUnechoedSteers(turnId, aborted || failed);

        if (aborted) {
            this.eventHandler?.({
                type: 'turn_aborted',
                ...(turnId ? { turn_id: turnId } : {}),
                ...(status ? { status } : {}),
                ...(error !== undefined && error !== null ? { error } : {}),
            });
            return;
        }

        this.eventHandler?.({
            type: 'task_complete',
            ...(turnId ? { turn_id: turnId } : {}),
            ...(status ? { status } : {}),
            ...(error !== undefined && error !== null ? { error } : {}),
        });
    }

    private handleRawNotification(method: string, params: any): boolean {
        if (!this.shouldHandleRawNotification(method)) {
            return false;
        }

        if (method === 'turn/started') {
            if (!this.isOwnThreadFrame(params)) {
                logger.debug(`[CodexAppServer] Child thread ${this.extractThreadId(params)} started a turn`);
                return true;
            }
            const turnId = this.extractTurnId(params);
            if (turnId) {
                this._turnId = turnId;
            }
            this.markPendingTurnStarted(turnId);
            this.eventHandler?.({
                type: 'task_started',
                ...(turnId ? { turn_id: turnId } : {}),
            });
            return true;
        }

        if (method === 'turn/completed') {
            if (!this.isOwnThreadFrame(params)) {
                logger.debug(`[CodexAppServer] Child thread ${this.extractThreadId(params)} ended a turn`);
                // B-628: the child's card ends with the child's own turn (mapper: → `stop`),
                // not only when the parent's turn ends.
                this.eventHandler?.({
                    type: 'subagent_turn_end',
                    ...this.childItemFields(params),
                    status: this.extractTurnStatus(params),
                });
                return true;
            }
            this.emitRawTurnCompletion(
                this.extractTurnId(params),
                this.extractTurnStatus(params),
                params?.turn?.error ?? params?.error,
                method,
            );
            return true;
        }

        if (method === 'thread/status/changed') {
            if (!this.isOwnThreadFrame(params)) return true;
            const statusType = params?.status?.type;
            // B-625: a stopped thread is not a turn end by itself. Codex ends every
            // turn it opened with exactly one `turn/completed` (a failed one after its
            // `error`), normally within a millisecond of the idle/systemError status;
            // a status seen before the turn opened is stale (a resumed thread
            // reporting itself idle under the turn/start in flight). So the status
            // only starts a short grace for a `turn/completed` that never comes.
            if ((statusType === 'idle' || statusType === 'systemError') && this.pendingTurnCompletion?.opened) {
                this.armThreadStopGrace(statusType);
            } else if (statusType === 'active') {
                this.clearThreadStopGrace();
            }
            return true;
        }

        if (method === 'thread/closed') {
            if (this.isOwnThreadFrame(params) && this.pendingTurnCompletion) {
                this.emitRawTurnCompletion(
                    this.pendingTurnCompletion.turnId ?? this._turnId,
                    'aborted',
                    { message: 'Codex closed the thread before the turn ended.' },
                    method,
                );
            }
            return true;
        }

        if (method === 'thread/tokenUsage/updated') {
            // B-628: per thread (a running total, Orca codex-subagent-activity.ts); a child's
            // would overwrite the session's own context-usage figure.
            if (!this.isOwnThreadFrame(params)) return true;
            const tokenUsage = params?.tokenUsage;
            if (tokenUsage && typeof tokenUsage === 'object') {
                this.eventHandler?.({
                    type: 'token_count',
                    ...tokenUsage,
                });
            }
            return true;
        }

        const item = params?.item;
        if (!item || typeof item !== 'object') {
            return method.startsWith('item/');
        }

        // B-628: an item from a child thread is the child's work (see childItemFields).
        const child = this.childItemFields(params);

        if ((method === 'item/started' || method === 'item/completed') && (item.type === 'collabAgentToolCall' || item.type === 'subAgentActivity')) {
            this.rememberChildLabels(item);
            this.eventHandler?.({ type: 'collab_agent_item', item, ...child });
            return true;
        }

        if (method === 'item/completed' && item.type === 'userMessage') {
            // B-628: Codex echoes a steered input as a userMessage item once the model took it
            // (`clientId` = our `clientUserMessageId`); until then it may still be dropped.
            const clientId = typeof item.clientId === 'string' ? item.clientId : null;
            if (clientId && !child.subagent) this.steeredAwaitingEcho.delete(clientId);
            return true;
        }

        if (method === 'item/started' && item.type === 'commandExecution') {
            const callId = typeof item.id === 'string' ? item.id : '';
            this.eventHandler?.({
                type: 'exec_command_begin',
                call_id: callId,
                callId,
                command: item.command,
                cwd: item.cwd,
                description: item.command,
                ...child,
            });
            return true;
        }

        if (method === 'item/completed' && item.type === 'commandExecution') {
            const callId = typeof item.id === 'string' ? item.id : '';
            this.eventHandler?.({
                type: 'exec_command_end',
                call_id: callId,
                callId,
                output: item.aggregatedOutput ?? '',
                exit_code: item.exitCode ?? null,
                duration_ms: item.durationMs ?? null,
                status: item.status,
                cwd: item.cwd,
                command: item.command,
                ...child,
            });
            return true;
        }

        if (item.type === 'fileChange') {
            const callId = typeof item.id === 'string' ? item.id : '';
            const changes = normalizeRawFileChangeList(item.changes);

            if (callId && changes) {
                this.rawFileChangesByItemId.set(callId, changes);
            }

            if (method === 'item/started') {
                this.eventHandler?.({
                    type: 'patch_apply_begin',
                    call_id: callId,
                    callId,
                    changes: changes ?? {},
                    ...child,
                });
                return true;
            }

            if (method === 'item/completed') {
                this.eventHandler?.({
                    type: 'patch_apply_end',
                    call_id: callId,
                    callId,
                    status: item.status,
                    ...child,
                });

                if (callId && (item.status === 'completed' || item.status === 'failed' || item.status === 'declined')) {
                    this.rawFileChangesByItemId.delete(callId);
                }
                return true;
            }
        }

        if (method === 'item/completed' && item.type === 'agentMessage') {
            const text = typeof item.text === 'string' ? item.text : '';
            if (text.length > 0) {
                this.eventHandler?.({
                    type: 'agent_message',
                    message: text,
                    item_id: item.id,
                    phase: item.phase,
                    ...child,
                });
            }

            // B-622: an agent message never ends the turn — not even one with
            // `phase: final_answer`. Codex's `send_message_to_user_async` tool
            // (0.154.0, core/src/tools/handlers/send_message_to_user_async.rs)
            // emits exactly that item *mid-turn* — "still working on it, now
            // checking X" — and then keeps running tools. Treating it as the
            // completion dropped `thinking` while Codex was still busy (no
            // spinner, "done" pushed early) and, via completedTurnIds above,
            // swallowed the real `turn/completed` — including its failure.
            // `turn/completed` (and `thread/status/changed: idle`, which the
            // app-server only reports with no turn in progress) end the turn;
            // probed on 0.154.0 for both the success and the 504 path.
            return true;
        }

        return method.startsWith('item/');
    }

    // ─── Lifecycle ──────────────────────────────────────────────

    async connect(): Promise<void> {
        if (this.connected) return;

        if (!isAppServerAvailable()) {
            throw new Error(
                'Codex CLI is not installed\n\n' +
                'Please install Codex CLI using one of these methods:\n\n' +
                'Option 1 - npm (recommended):\n  npm install -g @openai/codex\n\n' +
                'Option 2 - Homebrew (macOS):\n  brew install --cask codex\n\n' +
                'Alternatively, use Claude Code:\n  very-happy claude',
            );
        }

        let command = 'codex';
        let args = ['app-server', '--listen', 'stdio://'];
        this.sandboxEnabled = false;

        if (this.sandboxConfig?.enabled && process.platform !== 'win32') {
            try {
                this.sandboxCleanup = await initializeSandbox(this.sandboxConfig, process.cwd());
                const wrapped = await wrapForMcpTransport('codex', ['app-server', '--listen', 'stdio://']);
                command = wrapped.command;
                args = wrapped.args;
                this.sandboxEnabled = true;
                logger.info(`[CodexAppServer] Sandbox enabled`);
            } catch (error) {
                logger.warn('[CodexAppServer] Failed to initialize sandbox; continuing without.', error);
                this.sandboxCleanup = null;
            }
        }

        // Build env — same filtering as the old MCP client
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (typeof value === 'string') env[key] = value;
        }
        // Mute noisy rollout list logging
        const filter = 'codex_core::rollout::list=off';
        if (!env.RUST_LOG) {
            env.RUST_LOG = filter;
        } else if (!env.RUST_LOG.includes('codex_core::rollout::list=')) {
            env.RUST_LOG += `,${filter}`;
        }
        if (this.sandboxEnabled) {
            env.CODEX_SANDBOX = 'seatbelt';
        }

        logger.debug(`[CodexAppServer] Spawning: ${command} ${args.join(' ')}`);

        const epoch = ++this.processEpoch;
        // Use cross-spawn so npm-installed wrappers (codex.cmd / codex.ps1) resolve on Windows.
        // Native child_process.spawn fails with ENOENT for .cmd shims (issues #980, #1016).
        const proc = crossSpawn(command, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
            windowsHide: true,
        });
        this.process = proc;

        proc.on('error', (err) => {
            logger.debug('[CodexAppServer] Process error:', err);
        });

        proc.on('exit', (code, signal) => {
            logger.debug(`[CodexAppServer] Process exited: code=${code} signal=${signal}`);
            // Ignore stale process exits from prior generations during reconnect.
            if (this.process !== proc || this.processEpoch !== epoch) {
                logger.debug('[CodexAppServer] Ignoring stale process exit');
                return;
            }
            this.connected = false;
            const tail = this.stderrTail();
            const exited = `Codex process exited (code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''})`;
            // Reject all pending requests
            for (const [id, req] of this.pending) {
                if (req.epoch !== epoch) continue;
                const error = new Error(`${exited} while waiting for ${req.method}`);
                (error as Error & { codexStderrTail?: string }).codexStderrTail = tail;
                req.reject(error);
                this.pending.delete(id);
            }
            // B-625: a turn that was pending when the app-server died ends here, and
            // says so — with Codex's own last words — instead of resolving quietly.
            if (this.pendingTurnCompletion) {
                const turnId = this.pendingTurnCompletion.turnId ?? this._turnId;
                this.dropUnechoedSteers(null, true);
                this.eventHandler?.({
                    type: 'turn_aborted',
                    reason: 'process-exit',
                    ...(turnId ? { turn_id: turnId } : {}),
                    error: { message: `${exited}${tail ? `: ${tail}` : ''}` },
                });
            }
            // Resolve pending turn completion (treat as abort)
            this.resolvePendingTurn(true);
        });

        // Pipe stderr for debug logging; keep a tail for the exit message.
        this.stderrRing = '';
        // B-628: a respawned app-server may be a newer codex; its children are new too.
        this.steerUnsupported = false;
        this.steeredAwaitingEcho.clear();
        this.childThreadLabels.clear();
        proc.stderr?.on('data', (chunk: Buffer) => {
            if (this.process !== proc || this.processEpoch !== epoch) return;
            const text = chunk.toString().trim();
            if (text) {
                logger.debug('[CodexAppServer:stderr]', contentLogMetadata(text));
                this.stderrRing = `${this.stderrRing}\n${text}`.slice(-CodexAppServerClient.STDERR_TAIL_CHARS);
            }
        });

        // Parse newline-delimited JSON from stdout
        this.readline = createInterface({ input: proc.stdout! });
        this.readline.on('line', (line) => {
            if (this.process !== proc || this.processEpoch !== epoch) return;
            this.handleLine(line, epoch);
        });

        // Perform initialize handshake
        const initParams: InitializeParams = {
            clientInfo: {
                name: 'happy-codex',
                title: 'Happy Codex Client',
                version: packageJson.version,
            },
            capabilities: {
                experimentalApi: true,
            },
        };
        const initialized = await this.request('initialize', initParams) as Partial<InitializeResponse> | null;
        // B-852: `codex_cli_rs/0.155.0 (…)` → the agent version this app-server runs.
        this.serverVersion = typeof initialized?.userAgent === 'string' ? initialized.userAgent.match(/\/(\d+\.\d+\.\d+)\b/)?.[1] ?? null : null;
        this.notify('initialized');
        this.connected = true;
        logger.debug('[CodexAppServer] Connected and initialized');
        this.maybeRefreshRateLimits();
    }

    private async disconnectInternal(opts?: { preserveThreadState?: boolean }): Promise<void> {
        if (!this.connected && !this.process) return;

        const proc = this.process;
        const pid = proc?.pid;
        const epoch = this.processEpoch;
        logger.debug(`[CodexAppServer] Disconnecting; pid=${pid ?? 'none'}`);

        this.readline?.close();
        this.readline = null;

        // B-628: graceful first, then the whole tree under the launcher after 2s
        // (codexProcessTree.ts); unref so the timer never keeps this process alive.
        if (proc) {
            stopCodexProcess(proc);
            if (pid) {
                const killTimer = setTimeout(() => killCodexProcessTree(proc), CodexAppServerClient.FORCE_KILL_AFTER_MS);
                killTimer.unref();
            }
        }

        this.process = null;
        this.connected = false;
        this._turnId = null;
        this.notificationProtocol = 'unknown';
        this.completedTurnIds.clear();
        this.failedTurnIds.clear();
        this.lastTurnError = null;
        this.clearThreadStopGrace();
        if (!opts?.preserveThreadState) {
            this._threadId = null;
            this._threadModel = null;
            this.threadDefaults = null;
        }

        // Fail in-flight requests from this process generation.
        for (const [id, req] of this.pending) {
            if (req.epoch !== epoch) continue;
            req.reject(new Error(`Codex process disconnected while waiting for ${req.method}`));
            this.pending.delete(id);
        }

        // Resolve pending turn completion (treat as abort)
        this.dropUnechoedSteers(null, true);
        this.resolvePendingTurn(true);

        if (this.sandboxCleanup) {
            try { await this.sandboxCleanup(); } catch { /* ignore */ }
            this.sandboxCleanup = null;
        }
        this.sandboxEnabled = false;

        logger.debug('[CodexAppServer] Disconnected');
    }

    async disconnect(): Promise<void> {
        await this.disconnectInternal();
    }

    /** True while an app-server child process is owned by this client. */
    get hasProcess(): boolean {
        return this.process !== null;
    }

    /**
     * Drop the app-server process while the session is idle, keeping the thread
     * id and defaults so the next turn can `thread/resume` it (B-461). Refuses —
     * returning false — whenever anything is still in flight: an active turn, a
     * pending interrupt, or any outstanding RPC. See codexIdleRelease.ts.
     */
    async releaseIdleProcess(): Promise<boolean> {
        if (this.idleRelease) return this.idleRelease;
        if (!this.connected && !this.process) return false;
        if (this.pendingTurnCompletion || this.pendingInterrupt || this.pending.size > 0) {
            logger.debug('[CodexAppServer] Idle release skipped: work still in flight');
            return false;
        }
        const run = (async () => {
            const threadId = this._threadId;
            logger.debug(`[CodexAppServer] Releasing idle app-server; thread=${threadId ?? 'none'} kept for resume`);
            await this.disconnectInternal({ preserveThreadState: !!threadId });
            return true;
        })();
        this.idleRelease = run;
        try {
            return await run;
        } finally {
            if (this.idleRelease === run) this.idleRelease = null;
        }
    }

    /**
     * Make sure an app-server is running and, if a thread is remembered, resumed
     * in it. Cheap no-op while connected. Covers both the idle release above and
     * an app-server that exited on its own between turns.
     */
    async ensureConnected(): Promise<void> {
        if (this.idleRelease) await this.idleRelease;
        if (this.connected) return;
        const threadId = this._threadId;
        if (this.process) {
            // Process exited underneath us (exit handler flipped `connected`);
            // clean the stale handle before spawning a replacement.
            await this.disconnectInternal({ preserveThreadState: !!threadId });
        }
        await this.connect();
        if (threadId) {
            await this.resumeThread({ threadId });
        }
    }

    private buildThreadConfig(mcpServers?: Record<string, unknown>): Record<string, unknown> | null {
        return mcpServers ? { mcp_servers: mcpServers } : null;
    }

    private rememberThreadDefaults(opts: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
    }): void {
        this.threadDefaults = {
            model: opts.model,
            cwd: opts.cwd,
            approvalPolicy: opts.approvalPolicy,
            sandbox: opts.sandbox,
            mcpServers: opts.mcpServers,
        };
    }

    // ─── Thread management ──────────────────────────────────────

    async startThread(opts: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
    }): Promise<{ threadId: string; model: string }> {
        await this.ensureConnected();
        const params: NewConversationParams = {
            model: opts.model ?? null,
            modelProvider: null,
            profile: null,
            cwd: opts.cwd ?? process.cwd(),
            approvalPolicy: opts.approvalPolicy ?? null,
            sandbox: opts.sandbox ?? null,
            config: this.buildThreadConfig(opts.mcpServers),
            baseInstructions: null,
            developerInstructions: null,
            compactPrompt: null,
            includeApplyPatchTool: null,
            experimentalRawEvents: false,
            persistExtendedHistory: true,
        };

        const result = await this.request('thread/start', params) as NewConversationResponse;
        this._threadId = result.thread.id;
        this._turnId = null;
        this._threadModel = threadModelOf(result);
        this.rememberThreadDefaults(opts);
        logger.debug('[CodexAppServer] Thread started:', this._threadId);
        return { threadId: result.thread.id, model: result.model };
    }

    async resumeThread(opts?: {
        threadId?: string;
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
    }): Promise<{ threadId: string; model: string }> {
        const threadId = opts?.threadId ?? this._threadId;
        if (!threadId) {
            throw new Error('No thread available to resume.');
        }
        // ensureConnected() itself resumes a remembered thread after connect(); by
        // then `connected` is true so this is a no-op and never recurses.
        await this.ensureConnected();

        const defaults = this.threadDefaults ?? {};
        const params: ResumeConversationParams = {
            threadId,
            model: opts?.model ?? defaults.model ?? null,
            modelProvider: null,
            cwd: opts?.cwd ?? defaults.cwd ?? process.cwd(),
            approvalPolicy: opts?.approvalPolicy ?? defaults.approvalPolicy ?? null,
            sandbox: opts?.sandbox ?? defaults.sandbox ?? null,
            config: this.buildThreadConfig(opts?.mcpServers ?? defaults.mcpServers),
            baseInstructions: null,
            developerInstructions: null,
            persistExtendedHistory: true,
        };

        const result = await this.request('thread/resume', params) as ResumeConversationResponse;
        this._threadId = result.thread.id;
        this._turnId = null;
        this._threadModel = threadModelOf(result);
        this.rememberThreadDefaults({
            model: opts?.model ?? defaults.model,
            cwd: opts?.cwd ?? defaults.cwd,
            approvalPolicy: opts?.approvalPolicy ?? defaults.approvalPolicy,
            sandbox: opts?.sandbox ?? defaults.sandbox,
            mcpServers: opts?.mcpServers ?? defaults.mcpServers,
        });
        logger.debug('[CodexAppServer] Thread resumed:', this._threadId);
        return { threadId: result.thread.id, model: result.model };
    }

    async forkThread(opts: {
        threadId: string;
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
        lastTurnId?: string;
    }): Promise<{ threadId: string; model: string; thread: Thread }> {
        await this.ensureConnected();
        const defaults = this.threadDefaults ?? {};
        const params: ForkConversationParams = {
            threadId: opts.threadId,
            model: opts.model ?? defaults.model ?? null,
            modelProvider: null,
            cwd: opts.cwd ?? defaults.cwd ?? process.cwd(),
            approvalPolicy: opts.approvalPolicy ?? defaults.approvalPolicy ?? null,
            sandbox: opts.sandbox ?? defaults.sandbox ?? null,
            config: this.buildThreadConfig(opts.mcpServers ?? defaults.mcpServers),
            baseInstructions: null,
            developerInstructions: null,
            ephemeral: false,
            threadSource: null,
            ...(opts.lastTurnId ? { lastTurnId: opts.lastTurnId } : {}),
        };

        const result = await this.request('thread/fork', params) as ForkConversationResponse;
        this._threadId = result.thread.id;
        this._turnId = null;
        this._threadModel = threadModelOf(result);
        this.rememberThreadDefaults({
            model: opts.model ?? defaults.model,
            cwd: opts.cwd ?? defaults.cwd,
            approvalPolicy: opts.approvalPolicy ?? defaults.approvalPolicy,
            sandbox: opts.sandbox ?? defaults.sandbox,
            mcpServers: opts.mcpServers ?? defaults.mcpServers,
        });
        logger.debug('[CodexAppServer] Thread forked:', opts.threadId, '->', this._threadId);
        return { threadId: result.thread.id, model: result.model, thread: result.thread };
    }

    async readThread(opts: {
        threadId: string;
        includeTurns?: boolean;
    }): Promise<ReadConversationResponse> {
        await this.ensureConnected();
        const params: ReadConversationParams = {
            threadId: opts.threadId,
            includeTurns: opts.includeTurns ?? true,
        };
        return await this.request('thread/read', params) as ReadConversationResponse;
    }

    async rollbackThread(opts: {
        threadId: string;
        numTurns: number;
    }): Promise<RollbackConversationResponse> {
        await this.ensureConnected();
        const params: RollbackConversationParams = {
            threadId: opts.threadId,
            numTurns: opts.numTurns,
        };
        return await this.request('thread/rollback', params) as RollbackConversationResponse;
    }

    async injectItems(opts: {
        threadId: string;
        items: unknown[];
    }): Promise<InjectItemsResponse> {
        await this.ensureConnected();
        const params: InjectItemsParams = {
            threadId: opts.threadId,
            items: opts.items,
        };
        return await this.request('thread/inject_items', params) as InjectItemsResponse;
    }

    async reconnectAndResumeThread(): Promise<boolean> {
        const threadId = this._threadId;
        await this.disconnectInternal({ preserveThreadState: !!threadId });
        await this.connect();

        if (!threadId) {
            return false;
        }

        try {
            await this.resumeThread({ threadId });
            return true;
        } catch (error) {
            logger.warn('[CodexAppServer] Failed to resume thread after reconnect', error);
            this._threadId = null;
            this._threadModel = null;
            this.threadDefaults = null;
            return false;
        }
    }

    // ─── Turn management ────────────────────────────────────────

    /** Default grace period after interrupt before forcing a restart (ms). */
    private static readonly ABORT_GRACE_MS = 3_000;
    /** How long the graceful stop gets before the process tree is killed (disconnectInternal). */
    private static readonly FORCE_KILL_AFTER_MS = 2_000;

    private hasPendingTurnCompletion(): boolean {
        return this.pendingTurnCompletion !== null;
    }

    private resolvePendingTurn(aborted: boolean): void {
        if (!this.pendingTurnCompletion) return;
        this.lastResolvedTurnId = this.pendingTurnCompletion.turnId;
        this.clearTurnWatchdog();
        this.clearThreadStopGrace();
        this.pendingTurnCompletion.resolve(aborted);
        this.pendingTurnCompletion = null;
        this.releaseTurnOpenWaiters();
    }

    private markPendingTurnStarted(turnId?: string | null): void {
        if (!this.pendingTurnCompletion) return;
        this.pendingTurnCompletion.opened = true;
        if (turnId) {
            this.pendingTurnCompletion.turnId = turnId;
        }
        this.releaseTurnOpenWaiters();
    }

    // ─── B-628: steering the running turn ───────────────────────

    /** How long a steer waits for the pending turn to open before the message is queued instead. */
    private static readonly STEER_OPEN_WAIT_MS = 5_000;

    /** A turn Codex has reported running, under an id `turn/steer` can name. */
    private turnIsOpen(): boolean {
        return this.pendingTurnCompletion?.opened === true && this._turnId !== null;
    }

    private releaseTurnOpenWaiters(): void {
        const waiters = this.turnOpenWaiters;
        this.turnOpenWaiters = [];
        for (const release of waiters) release();
    }

    /**
     * Waits for the pending turn to open — `turn/start` is in flight, or the runner is still
     * bringing a released app-server back before sending it (B-461) — as Orca's send does
     * (codex-structured-turn-open-wait.ts, 5 s). Resolves early when the turn ends instead.
     */
    private async waitForTurnOpen(timeoutMs: number): Promise<boolean> {
        if (this.turnIsOpen()) return true;
        if (timeoutMs <= 0) return false;
        await new Promise<void>((resolve) => {
            const release = () => {
                clearTimeout(timer);
                resolve();
            };
            const timer = setTimeout(release, timeoutMs);
            timer.unref();
            this.turnOpenWaiters.push(release);
        });
        return this.turnIsOpen();
    }

    /**
     * B-628: send a message into the turn running right now (`turn/steer`, codex ≥ 0.148 /
     * app-server-protocol v2 `TurnSteerParams`). Codex appends it to that turn's pending input
     * and the model reads it before its next call; the turn keeps its own model, approval
     * policy and sandbox — the runner applies any change on the next `turn/start`. Codex
     * refuses before taking any input (expectedTurnId is a precondition), so a non-`steered`
     * outcome always means "queue it for the next turn as before": `no-turn` (nothing running,
     * or it ended while we waited), `unsupported` (this app-server has no `turn/steer`,
     * remembered until it is respawned), `refused` (Codex declined this one), `failed`
     * (transport — the turn itself is reported through its own events).
     */
    async steerTurn(input: { text: string; images?: string[]; clientId?: string }, opts?: { waitForTurnMs?: number }): Promise<CodexSteerOutcome> {
        if (this.steerUnsupported) return 'unsupported';
        if (this.pendingInterrupt) return 'no-turn';
        const opened = await this.waitForTurnOpen(opts?.waitForTurnMs ?? CodexAppServerClient.STEER_OPEN_WAIT_MS);
        const threadId = this._threadId;
        const turnId = this._turnId;
        if (!opened || !threadId || !turnId || !this.connected || this.pendingInterrupt) return 'no-turn';
        const params = {
            threadId,
            expectedTurnId: turnId,
            ...(input.clientId ? { clientUserMessageId: input.clientId } : {}),
            input: [
                { type: 'text', text: input.text },
                ...(input.images ?? []).map((path): InputItem => ({ type: 'localImage', path })),
            ] satisfies InputItem[],
        };
        try {
            const result = await this.request('turn/steer', params) as { turnId?: unknown } | null;
            const steeredTurnId = typeof result?.turnId === 'string' && result.turnId.length > 0 ? result.turnId : turnId;
            if (input.clientId) this.steeredAwaitingEcho.set(input.clientId, steeredTurnId);
            logger.debug(`[CodexAppServer] Steered a message into turn ${steeredTurnId}`);
            return 'steered';
        } catch (error) {
            const code = jsonRpcErrorCodeOf(error);
            if (code === -32601) {
                this.steerUnsupported = true;
                logger.debug('[CodexAppServer] turn/steer is not supported by this codex; queuing instead');
                return 'unsupported';
            }
            if (code !== null) {
                logger.debug('[CodexAppServer] turn/steer refused:', errorLogMetadata(error));
                return 'refused';
            }
            logger.debug('[CodexAppServer] turn/steer failed:', errorLogMetadata(error));
            return 'failed';
        }
    }

    /** Default wait for Codex's `turn/completed` after its thread reported idle/systemError. */
    private static readonly THREAD_STOP_GRACE_MS = 1_500;

    /**
     * B-625: the own thread stopped (idle / systemError) while a turn was pending and
     * had opened. Codex's `turn/completed` follows at once in every probed release
     * (0.154.0: 1 ms); this is the net under a release that does not send it, so the
     * session never waits on the silence watchdog for a turn Codex has already left.
     */
    private armThreadStopGrace(statusType: 'idle' | 'systemError'): void {
        this.clearThreadStopGrace();
        const graceMs = this.pendingTurnCompletion?.threadStopGraceMs ?? CodexAppServerClient.THREAD_STOP_GRACE_MS;
        this.threadStopGrace = setTimeout(() => {
            this.threadStopGrace = null;
            const pending = this.pendingTurnCompletion;
            if (!pending) return;
            const turnId = pending.turnId ?? this._turnId;
            const lastError = this.lastTurnError && (!turnId || !this.lastTurnError.turnId || this.lastTurnError.turnId === turnId)
                ? this.lastTurnError.error
                : null;
            logger.warn(`[CodexAppServer] Thread went ${statusType} and no turn/completed followed for turn ${turnId ?? '?'}; ending the turn`);
            const failed = statusType === 'systemError' || lastError !== null;
            this.emitRawTurnCompletion(
                turnId,
                failed ? 'failed' : 'completed',
                lastError ?? (failed ? { message: 'Codex reported a system error and ended the turn without a verdict.' } : null),
                `thread/status/changed:${statusType}`,
            );
        }, graceMs);
    }

    private clearThreadStopGrace(): void {
        if (!this.threadStopGrace) return;
        clearTimeout(this.threadStopGrace);
        this.threadStopGrace = null;
    }

    private tryResolvePendingTurn(aborted: boolean, turnId: string | null, source: string): void {
        const pending = this.pendingTurnCompletion;
        if (!pending) return;

        // Guard against stale completion notifications from a *different* turn.
        // We use turn ID matching instead of the `started` flag because Codex
        // can skip the turn/started notification entirely for fast turns,
        // which would cause us to discard a valid turn/completed and hang forever.
        if (pending.turnId && turnId && pending.turnId !== turnId) {
            logger.debug(
                `[CodexAppServer] Ignoring ${source} for turn ${turnId}; awaiting ${pending.turnId}`,
            );
            return;
        }

        if (!pending.turnId && turnId) pending.turnId = turnId;
        this.resolvePendingTurn(aborted);
    }

    private async waitForTurnCompletion(timeoutMs: number): Promise<boolean> {
        if (!this.hasPendingTurnCompletion()) {
            return true;
        }

        const deadline = Date.now() + Math.max(0, timeoutMs);
        while (this.hasPendingTurnCompletion()) {
            if (Date.now() >= deadline) {
                return false;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return true;
    }

    /**
     * Request turn interruption and optionally force-restart the app-server if
     * the turn does not settle within a short grace period.
     */
    async abortTurnWithFallback(opts?: {
        gracePeriodMs?: number;
        forceRestartOnTimeout?: boolean;
    }): Promise<{ hadActiveTurn: boolean; aborted: boolean; forcedRestart: boolean; resumedThread: boolean }> {
        const hadActiveTurn = this.hasPendingTurnCompletion();

        // No active turn pending in this client call-site.
        if (!hadActiveTurn) {
            return { hadActiveTurn: false, aborted: false, forcedRestart: false, resumedThread: false };
        }

        // Best-effort interrupt request first.
        await this.interruptTurn();

        const gracePeriodMs = opts?.gracePeriodMs ?? CodexAppServerClient.ABORT_GRACE_MS;
        const settled = await this.waitForTurnCompletion(gracePeriodMs);
        if (settled) {
            return { hadActiveTurn: true, aborted: true, forcedRestart: false, resumedThread: false };
        }

        const shouldForceRestart = opts?.forceRestartOnTimeout ?? true;
        if (!shouldForceRestart) {
            return { hadActiveTurn: true, aborted: false, forcedRestart: false, resumedThread: false };
        }

        logger.warn(`[CodexAppServer] interrupt did not settle turn in ${gracePeriodMs}ms; force-restarting app-server`);
        const pendingTurnId = this.pendingTurnCompletion?.turnId ?? this._turnId;
        if (this.pendingTurnCompletion) {
            this.eventHandler?.({
                type: 'turn_aborted',
                reason: 'interrupted',
                ...(pendingTurnId ? { turn_id: pendingTurnId } : {}),
                forced_restart: true,
            });
        }
        const resumedThread = await this.reconnectAndResumeThread();
        return { hadActiveTurn: true, aborted: true, forcedRestart: true, resumedThread };
    }

    /**
     * Send a user turn and wait for it to complete.
     * Returns when task_complete or turn_aborted is received.
     */
    async sendTurn(prompt: string, opts?: {
        images?: string[];
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        effort?: ReasoningEffort;
    }): Promise<void> {
        if (!this._threadId) {
            throw new Error('No active thread. Call startThread first.');
        }
        await this.ensureConnected();

        const input: InputItem[] = [
            { type: 'text', text: prompt },
            ...(opts?.images ?? []).map((path): InputItem => ({ type: 'localImage', path })),
        ];

        // Build params — only include optional fields when set (server uses thread defaults otherwise)
        const params: Record<string, unknown> = {
            threadId: this._threadId,
            input,
        };
        if (opts?.cwd) params.cwd = opts.cwd;
        if (opts?.approvalPolicy) params.approvalPolicy = opts.approvalPolicy;
        if (opts?.model) params.model = opts.model;
        if (opts?.effort) params.effort = opts.effort;

        // Map sandbox mode to the camelCase policy format the server expects
        if (opts?.sandbox) {
            switch (opts.sandbox) {
                case 'workspace-write':
                    params.sandboxPolicy = { type: 'workspaceWrite' };
                    break;
                case 'danger-full-access':
                    params.sandboxPolicy = { type: 'dangerFullAccess' };
                    break;
                case 'read-only':
                    params.sandboxPolicy = { type: 'readOnly' };
                    break;
            }
        }

        // turn/start returns immediately; turn completes via events.
        // We don't await completion here — the caller's event handler
        // tracks task_complete / turn_aborted.
        const result = await this.request('turn/start', params) as { turn?: { id?: string | null } };
        // B-844d: an accepted turn model becomes the thread's model; a later
        // idle-release/forced-restart resume must not put the start model back.
        if (opts?.model) {
            this._threadModel = opts.model;
            if (this.threadDefaults) this.threadDefaults.model = opts.model;
        }
        const turnId = result?.turn?.id;
        if (typeof turnId === 'string' && turnId.length > 0) {
            this._turnId = turnId;
            if (this.pendingTurnCompletion) {
                this.pendingTurnCompletion.turnId = turnId;
            }
        }
    }

    /** Default timeout for waiting on turn completion (ms). 10 minutes. */
    private static readonly TURN_TIMEOUT_MS = 10 * 60 * 1000;
    /** How much of the app-server's stderr is kept for its exit message. */
    private static readonly STDERR_TAIL_CHARS = 400;

    /**
     * Send a user turn and wait for it to complete (task_complete or turn_aborted).
     * Returns { aborted: true } if the turn was aborted (user cancel, permission reject, etc.).
     */
    async sendTurnAndWait(prompt: string, opts?: {
        images?: string[];
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        effort?: ReasoningEffort;
        turnTimeoutMs?: number;
        /** B-625: test hook for the thread-stop grace (see armThreadStopGrace). */
        threadStopGraceMs?: number;
        /**
         * B-854: Codex accepted `turn/start` — the prompt is the thread's now.
         * Not called when the app-server could not be brought back or the
         * request was rejected: that prompt never ran.
         */
        onTurnStarted?: () => void;
    }): Promise<{ aborted: boolean }> {
        const { aborted } = await this.runTurnAndWait(async () => {
            await this.sendTurn(prompt, opts);
            opts?.onTurnStarted?.();
        }, opts);
        return { aborted };
    }

    /**
     * `/compact`: Codex compacts the thread in a turn of its own
     * (`thread/compact/start` answers `{}`, then `turn/started` →
     * `contextCompaction` item → `turn/completed`, probed on codex-cli 0.154).
     * Waits for that turn like any other; `failed` is the turn's own verdict.
     */
    async compactThreadAndWait(opts?: { turnTimeoutMs?: number; threadStopGraceMs?: number }): Promise<{ aborted: boolean; failed: boolean }> {
        return this.runTurnAndWait(async () => {
            if (!this._threadId) {
                throw new Error('No active thread. Call startThread first.');
            }
            await this.request('thread/compact/start', { threadId: this._threadId });
        }, opts);
    }

    private async runTurnAndWait(start: () => Promise<void>, opts?: {
        turnTimeoutMs?: number;
        threadStopGraceMs?: number;
    }): Promise<{ aborted: boolean; failed: boolean }> {
        // Wait for any in-flight interruptTurn() to complete before starting a new
        // turn. Otherwise the stale turn/interrupt RPC can reach Codex after our
        // turn/start and abort the wrong turn.
        if (this.pendingInterrupt) {
            await this.pendingInterrupt;
            // Yield to the event loop so any stale turn_aborted/task_complete
            // notifications queued by the interrupted turn are processed now
            // (harmlessly, since pendingTurnCompletion is null at this point).
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        // Respawn + resume before registering the turn completion, so a released
        // (B-461) or crashed app-server is brought back without a pending turn
        // that the reconnect's disconnectInternal() would otherwise resolve as aborted.
        await this.ensureConnected();

        const timeoutMs = opts?.turnTimeoutMs ?? CodexAppServerClient.TURN_TIMEOUT_MS;

        const completion = new Promise<boolean>((resolve) => {
            this.pendingTurnCompletion = {
                resolve,
                turnId: null,
                opened: false,
                threadStopGraceMs: opts?.threadStopGraceMs ?? CodexAppServerClient.THREAD_STOP_GRACE_MS,
            };
            this.lastTurnError = null;
            // B-622: a bound on Codex going *silent*, re-armed by every
            // notification (handleNotification) — not a cap on turn length.
            // The old fixed 10-minute timer resolved every longer max-effort
            // turn as "aborted" while Codex kept working: the wrapper dropped
            // `thinking`, pushed "done", and the rest of the turn rendered
            // into a session that looked idle.
            this.armTurnWatchdog(timeoutMs);
        });

        try {
            await start();
        } catch (err) {
            this.clearTurnWatchdog();
            this.pendingTurnCompletion = null;
            // B-628: a steer waiting for this turn to open learns now that it never will.
            this.releaseTurnOpenWaiters();
            throw err;
        }

        const aborted = await completion;
        this.clearTurnWatchdog();
        const turnId = this.lastResolvedTurnId;
        return { aborted, failed: turnId !== null && this.failedTurnIds.has(turnId) };
    }

    private armTurnWatchdog(timeoutMs: number): void {
        this.clearTurnWatchdog();
        const timer = setTimeout(() => {
            this.turnWatchdog = null;
            if (!this.pendingTurnCompletion) return;
            if (this.inflightServerRequests > 0) {
                // Codex is waiting on us (an approval the user has not answered).
                this.armTurnWatchdog(timeoutMs);
                return;
            }
            logger.warn(`[CodexAppServer] No notification from Codex for ${timeoutMs}ms — giving the turn up as aborted`);
            const turnId = this.pendingTurnCompletion.turnId ?? this._turnId;
            // B-628: this end bypasses emitRawTurnCompletion; what was steered into it was never read.
            this.dropUnechoedSteers(turnId, true);
            this.eventHandler?.({
                type: 'turn_aborted',
                reason: 'timeout',
                ...(turnId ? { turn_id: turnId } : {}),
                error: { message: `Codex sent nothing for ${Math.max(1, Math.round(timeoutMs / 60_000))} minutes; this turn was given up. Send the message again, or restart the session if it keeps happening.` },
            });
            this.resolvePendingTurn(true);
        }, timeoutMs);
        this.turnWatchdog = { timer, timeoutMs };
    }

    /** Any sign of life from the app-server while a turn is pending restarts the clock. */
    private touchTurnWatchdog(): void {
        if (!this.turnWatchdog || !this.pendingTurnCompletion) return;
        this.armTurnWatchdog(this.turnWatchdog.timeoutMs);
    }

    private clearTurnWatchdog(): void {
        if (!this.turnWatchdog) return;
        clearTimeout(this.turnWatchdog.timer);
        this.turnWatchdog = null;
    }

    async interruptTurn(): Promise<void> {
        if (!this._threadId) return;
        if (!this._turnId) {
            logger.debug('[CodexAppServer] interruptTurn: no active turnId, skipping');
            return;
        }
        const params: InterruptConversationParams = {
            threadId: this._threadId,
            turnId: this._turnId,
        };
        const doInterrupt = async () => {
            try {
                await this.request('turn/interrupt', params);
            } catch (err) {
                // Ignore if no turn is active
                logger.debug('[CodexAppServer] interruptTurn error (may be expected):', err);
            } finally {
                this.pendingInterrupt = null;
            }
        };
        this.pendingInterrupt = doInterrupt();
        return this.pendingInterrupt;
    }

    // ─── State queries ──────────────────────────────────────────

    hasActiveThread(): boolean {
        return this._threadId !== null;
    }

    clearThreadState(): void {
        logger.debug(
            `[CodexAppServer] Clearing thread state: thread=${this._threadId ?? 'none'} turn=${this._turnId ?? 'none'}`,
        );
        this.dropUnechoedSteers(null, true);
        this.resolvePendingTurn(true);
        this._threadId = null;
        this._turnId = null;
        this._threadModel = null;
        this.threadDefaults = null;
        this.completedTurnIds.clear();
        this.failedTurnIds.clear();
        this.lastTurnError = null;
        this.rawFileChangesByItemId.clear();
        this.childThreadLabels.clear();
    }

    // ─── JSON-RPC transport ─────────────────────────────────────

    /** Default timeout for RPC requests (ms). */
    private static readonly REQUEST_TIMEOUT_MS = 30_000;

    async listModels(): Promise<CodexModel[]> {
        const models: CodexModel[] = [];
        let cursor: string | null = null;
        const seenCursors = new Set<string>();
        do {
            const response = await this.request('model/list', { limit: 100, cursor, includeHidden: false }) as {
                data: CodexModel[]; nextCursor?: string | null;
            };
            models.push(...response.data.filter((model) => !model.hidden));
            cursor = response.nextCursor ?? null;
            if (cursor && seenCursors.has(cursor)) throw new Error('Repeated model/list cursor');
            if (cursor) seenCursors.add(cursor);
        } while (cursor);
        return models;
    }

    /**
     * B-844: the model Codex's effective configuration pins (config.toml,
     * profile, CLI overrides) via `config/read`; null = nothing pinned.
     * Throws when this Codex has no `config/read` — the caller then reports
     * nothing (unknown) and the web sends no model.
     */
    async readConfiguredModel(cwd: string): Promise<string | null> {
        const response = await this.request('config/read', { cwd }, 10_000) as { config?: { model?: unknown } };
        const model = response?.config?.model;
        return typeof model === 'string' && model.trim() ? model.trim() : null;
    }

    private request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
        const timeout = timeoutMs ?? CodexAppServerClient.REQUEST_TIMEOUT_MS;
        return new Promise((resolve, reject) => {
            if (!this.process?.stdin?.writable) {
                reject(new Error(`Cannot send ${method}: stdin not writable`));
                return;
            }
            const id = this.nextId++;

            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} timed out after ${timeout}ms (id=${id})`));
            }, timeout);

            this.pending.set(id, {
                resolve: (result) => { clearTimeout(timer); resolve(result); },
                reject: (err) => { clearTimeout(timer); reject(err); },
                method,
                epoch: this.processEpoch,
            });

            const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
            const line = JSON.stringify(msg) + '\n';
            logger.debug(`[CodexAppServer] → ${method} (id=${id})`);
            this.process.stdin.write(line);
        });
    }

    private notify(method: string, params?: unknown): void {
        if (!this.process?.stdin?.writable) return;
        const msg: JsonRpcRequest = { jsonrpc: '2.0', method, params };
        this.process.stdin.write(JSON.stringify(msg) + '\n');
        logger.debug(`[CodexAppServer] → ${method} (notification)`);
    }

    private respond(id: number, result: unknown): void {
        if (!this.process?.stdin?.writable) return;
        const msg: JsonRpcResponse = { jsonrpc: '2.0', id, result };
        this.process.stdin.write(JSON.stringify(msg) + '\n');
        logger.debug(`[CodexAppServer] → response (id=${id})`);
    }

    private handleLine(line: string, sourceEpoch: number = this.processEpoch): void {
        if (sourceEpoch !== this.processEpoch) {
            return;
        }
        if (!line.trim()) return;

        let msg: any;
        try {
            msg = JSON.parse(line);
        } catch {
            logger.debug('[CodexAppServer] Non-JSON line received:', contentLogMetadata(line));
            return;
        }

        // Response to our request
        if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
            const pending = this.pending.get(msg.id);
            if (pending) {
                if (pending.epoch !== sourceEpoch) {
                    logger.debug(`[CodexAppServer] Ignoring response from stale epoch for id=${msg.id}`);
                    return;
                }
                this.pending.delete(msg.id);
                if (msg.error) {
                    const error = new Error(`${pending.method}: ${msg.error.message} (code=${msg.error.code})`);
                    // B-628: the code itself, for callers that tell "no such method" from "refused".
                    if (typeof msg.error.code === 'number') (error as Error & { jsonRpcCode?: number }).jsonRpcCode = msg.error.code;
                    pending.reject(error);
                } else {
                    pending.resolve(msg.result);
                }
            }
            return;
        }

        // Server → client request (approvals)
        if (msg.id != null && msg.method) {
            this.handleServerRequest(msg.id, msg.method, msg.params).catch((err) => {
                logger.debug('[CodexAppServer] Error handling server request:', errorLogMetadata(err));
            });
            return;
        }

        // Notification (no id)
        if (msg.method) {
            this.handleNotification(msg.method, msg.params);
            return;
        }

        logger.debug('[CodexAppServer] Unhandled message:', contentLogMetadata(msg));
    }

    /**
     * Map our internal ReviewDecision to the wire format the server expects.
     * Server uses: accept, acceptForSession, decline, cancel
     * Our handler uses: approved, approved_for_session, denied, abort
     */
    /**
     * Map our internal ReviewDecision to the wire format codex expects.
     * v2 methods (item/*) use: accept/acceptForSession/decline/cancel
     * Legacy methods (execCommandApproval/applyPatchApproval) use: approved/approved_for_session/denied/abort
     */
    private mapDecisionToWire(decision: ReviewDecision, legacy: boolean): string | Record<string, unknown> {
        if (typeof decision === 'string') {
            if (legacy) {
                // Legacy wire format — pass through as-is (approved/denied/abort)
                return decision;
            }
            // v2 wire format
            switch (decision) {
                case 'approved': return 'accept';
                case 'approved_for_session': return 'acceptForSession';
                case 'denied': return 'decline';
                case 'abort': return 'cancel';
                default: return 'decline';
            }
        }
        // Object variant: approved_execpolicy_amendment → pass through as-is
        if ('approved_execpolicy_amendment' in decision) {
            return decision;
        }
        return legacy ? 'denied' : 'decline';
    }

    private parseToolNameFromElicitationMessage(message: unknown): string | null {
        if (typeof message !== 'string') {
            return null;
        }
        const match = message.match(/tool "([^"]+)"/i);
        return match?.[1] ?? null;
    }

    private mapDecisionToMcpElicitationResponse(
        decision: ReviewDecision,
        params: any,
    ): McpServerElicitationRequestResponse {
        if (typeof decision === 'string') {
            switch (decision) {
                case 'approved':
                case 'approved_for_session':
                    return {
                        action: 'accept',
                        content: params?.mode === 'form' ? {} : null,
                        _meta: null,
                    };
                case 'abort':
                    return {
                        action: 'cancel',
                        content: null,
                        _meta: null,
                    };
                case 'denied':
                default:
                    return {
                        action: 'decline',
                        content: null,
                        _meta: null,
                    };
            }
        }

        return {
            action: 'decline',
            content: null,
            _meta: null,
        };
    }

    private async handleServerRequest(id: number, method: string, params: any): Promise<void> {
        // B-622: while Codex waits on our answer (approval, elicitation) the
        // turn watchdog must not count the silence against it.
        this.inflightServerRequests += 1;
        try {
            await this.handleServerRequestInner(id, method, params);
        } finally {
            this.inflightServerRequests -= 1;
            this.touchTurnWatchdog();
        }
    }

    private async handleServerRequestInner(id: number, method: string, params: any): Promise<void> {
        if (method === 'mcpServer/elicitation/request') {
            const toolName = this.parseToolNameFromElicitationMessage(params?.message) ?? params?.serverName ?? 'McpTool';
            const decision = await this.handleApproval({
                type: 'mcp',
                callId: `${params?.serverName ?? 'mcp'}:${id}`,
                toolName,
                input: params?._meta?.tool_params ?? {},
                serverName: params?.serverName,
                message: params?.message,
            });
            this.respond(id, this.mapDecisionToMcpElicitationResponse(decision, params));
            return;
        }

        // Command execution approval
        if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
            const legacy = method === 'execCommandApproval';
            const callId = params.itemId ?? params.callId ?? String(id);
            const decision = await this.handleApproval({
                type: 'exec',
                callId,
                command: params.command != null ? [params.command] : [],
                cwd: params.cwd,
                reason: params.reason,
            });
            this.respond(id, { decision: this.mapDecisionToWire(decision, legacy) });
            return;
        }

        // File change / patch approval
        if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
            const legacy = method === 'applyPatchApproval';
            const callId = params.itemId ?? params.callId ?? String(id);
            const decision = await this.handleApproval({
                type: 'patch',
                callId,
                fileChanges: params.fileChanges ?? (typeof callId === 'string'
                    ? this.rawFileChangesByItemId.get(callId)
                    : undefined),
                reason: params.reason,
            });
            this.respond(id, { decision: this.mapDecisionToWire(decision, legacy) });
            return;
        }

        // Unknown server request — respond so server doesn't hang
        logger.debug(`[CodexAppServer] Unknown server request: ${method}`);
        this.respond(id, {});
    }

    private async handleApproval(params: Parameters<ApprovalHandler>[0]): Promise<ReviewDecision> {
        if (this.approvalHandler) {
            try {
                return await this.approvalHandler(params);
            } catch (err) {
                logger.debug('[CodexAppServer] Approval handler error:', err);
                return 'denied';
            }
        }
        return 'denied'; // default: deny if no handler
    }

    private handleNotification(method: string, params: any): void {
        // B-622: anything the app-server says while a turn is pending is a sign of life.
        this.touchTurnWatchdog();

        // codex/event notifications: either `codex/event` or `codex/event/<type>`
        if (method === 'codex/event' || method.startsWith('codex/event/')) {
            this.notificationProtocol = 'legacy';
            const msg = params?.msg;
            if (msg) {
                // Extract turn_id from task_started events
                if (msg.type === 'task_started' && msg.turn_id) {
                    this._turnId = msg.turn_id;
                }
                if (msg.type === 'task_started') {
                    this.markPendingTurnStarted(msg.turn_id ?? msg.turnId ?? null);
                }
                // Fire event handler first (so consumer processes the event)
                this.eventHandler?.(msg);
                // Then resolve turn completion promise
                if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
                    const turnId = msg.turn_id ?? msg.turnId ?? null;
                    // Mark as completed so v2 turn/completed doesn't duplicate
                    if (turnId) {
                        this.completedTurnIds.add(turnId);
                    }
                    this.tryResolvePendingTurn(
                        msg.type === 'turn_aborted',
                        turnId,
                        `codex/event/${msg.type}`,
                    );
                    this._turnId = null;
                    this.maybeRefreshRateLimits();
                }
            }
            return;
        }

        if (this.handleRawNotification(method, params)) {
            logger.debug(`[CodexAppServer] Raw notification: ${method}`);
            return;
        }

        // v2 lifecycle notifications
        if (method === 'thread/started' || method === 'turn/started' ||
            method === 'turn/completed' || method === 'thread/status/changed') {
            logger.debug(`[CodexAppServer] Lifecycle notification: ${method}`);
            // B-625: a child thread's lifecycle is the child's (see isOwnThreadFrame).
            if (!this.isOwnThreadFrame(params)) return;
            // Mark the turn as started so the completion guard lets it through.
            if (method === 'turn/started') {
                const turnId = this.extractTurnId(params);
                if (turnId) {
                    this._turnId = turnId;
                }
                this.markPendingTurnStarted(turnId);
            }
            // turn/completed is a fallback signal — for mid-inference interrupts,
            // Codex may only signal completion here (not via codex/event turn_aborted).
            // emitRawTurnCompletion deduplicates via completedTurnIds if legacy already handled it.
            if (method === 'turn/completed') {
                this.emitRawTurnCompletion(
                    this.extractTurnId(params),
                    this.extractTurnStatus(params),
                    params?.turn?.error ?? params?.error,
                    method,
                );
            }
            return;
        }

        if (method === 'account/rateLimits/updated') {
            const snapshot = params?.rateLimits;
            if (snapshot) this.rateLimitHandler?.(snapshot);
            return;
        }

        // MCP server lifecycle: log payload so we can diagnose failed launches
        // (e.g. happy-mcp bridge failing on Windows due to shebang execution).
        if (method === 'mcpServer/startupStatus/updated') {
            logger.debug(`[CodexAppServer] mcpServer startup status:`, params);
            return;
        }

        if (method === 'error') {
            // B-625: a child thread's error is the child's.
            if (!this.isOwnThreadFrame(params)) return;
            const error = params?.error ?? {};
            const turnId = typeof params?.turnId === 'string' && params.turnId.length > 0 ? params.turnId : null;
            // B-622: Codex's own retry notice — a 5xx or a dropped stream it is about
            // to retry ("Reconnecting... 2/5", codex 0.154.0). Only the retrying ones
            // are forwarded: the final failure arrives again on turn/completed.
            if (params?.willRetry === true) {
                const message = typeof error.message === 'string' ? error.message : '';
                const info = error.codexErrorInfo;
                const httpStatus = info && typeof info === 'object'
                    ? (info.responseStreamDisconnected?.httpStatusCode ?? info.httpStatusCode ?? null)
                    : null;
                this.eventHandler?.({
                    type: 'turn_retry',
                    message,
                    ...(typeof httpStatus === 'number' ? { http_status: httpStatus } : {}),
                    ...(turnId ? { turn_id: turnId } : {}),
                    ...(typeof error.additionalDetails === 'string' ? { details: error.additionalDetails } : {}),
                });
                return;
            }
            // B-625: the final error. Kept for a turn end that arrives without a
            // verdict (the thread-stop grace), and — before codex 0.148 — for a
            // turn that never opened it IS the end: such a turn reports no
            // `turn/completed` (Orca, codex-structured-turn-end-settlement.ts
            // `unopenedTurnFailure`). One that opened still reports its own.
            this.lastTurnError = { turnId, error };
            const pending = this.pendingTurnCompletion;
            if (pending && !pending.opened && (turnId === null || pending.turnId === null || pending.turnId === turnId)) {
                this.emitRawTurnCompletion(turnId ?? pending.turnId, 'failed', error, 'error:unopened-turn');
            }
            return;
        }

        logger.debug(`[CodexAppServer] Notification: ${method}`);
    }
}
