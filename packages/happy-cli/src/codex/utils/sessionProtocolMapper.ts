import { randomUUID } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import type { ReasoningOutput } from './reasoningProcessor';
import type { DiffToolCall, DiffToolResult } from './diffProcessor';
import { createEnvelope, type CreateEnvelopeOptions, type SessionEnvelope } from '@slopus/happy-wire';
import type { Thread, ThreadItem, ThreadTurn } from '../codexAppServerTypes';
import { textResultPayload, toolResultContentText } from '@/sessionProtocol/toolResultPayload';

export type CodexTurnState = {
    currentTurnId: string | null;
    startedSubagents?: Set<string>;
    activeSubagents?: Set<string>;
    providerSubagentToSessionSubagent?: Map<string, string>;
    /** B-628: session sub-agents whose card title (`description`) has been sent. */
    labeledSubagents?: Set<string>;
};

type CodexMapperResult = {
    currentTurnId: string | null;
    startedSubagents: Set<string>;
    activeSubagents: Set<string>;
    providerSubagentToSessionSubagent: Map<string, string>;
    labeledSubagents: Set<string>;
    envelopes: SessionEnvelope[];
};

type LegacyToolLikeMessage = {
    type: 'tool-call' | 'tool-call-result';
    callId: string;
    name?: string;
    input?: unknown;
    output?: {
        content?: string;
        status?: 'completed' | 'canceled';
    };
};

type TurnEndStatus = 'completed' | 'failed' | 'cancelled';

function getStartedSubagents(state: CodexTurnState): Set<string> {
    return state.startedSubagents ?? new Set<string>();
}

function getActiveSubagents(state: CodexTurnState): Set<string> {
    return state.activeSubagents ?? new Set<string>();
}

function getProviderSubagentToSessionSubagent(state: CodexTurnState): Map<string, string> {
    return state.providerSubagentToSessionSubagent ?? new Map<string, string>();
}

function getLabeledSubagents(state: CodexTurnState): Set<string> {
    return state.labeledSubagents ?? new Set<string>();
}

function maybeEmitSubagentStart(
    subagent: string | undefined,
    opts: CreateEnvelopeOptions,
    startedSubagents: Set<string>,
    activeSubagents: Set<string>,
    envelopes: SessionEnvelope[],
    label?: string,
    labeledSubagents: Set<string> = new Set<string>(),
): void {
    if (!subagent) {
        return;
    }
    // B-628: a Codex child thread's card is titled by the name Codex gave it (the
    // prompt it was spawned with / its agentPath leaf) — `description` is what the
    // web reads for the title; without it the card is the generic「子代理」. The name
    // can arrive after the child's first item (the parent's spawn call completes with
    // the child's thread id while the child already runs), so a started card gets a
    // second `start` carrying it: the web's reducer takes the newer event's fields.
    if (startedSubagents.has(subagent)) {
        if (label && !labeledSubagents.has(subagent)) {
            envelopes.push(createEnvelope('agent', { t: 'start', description: label }, { ...opts, subagent }));
            labeledSubagents.add(subagent);
        }
        return;
    }

    envelopes.push(createEnvelope('agent', { t: 'start', ...(label ? { description: label } : {}) }, { ...opts, subagent }));
    startedSubagents.add(subagent);
    activeSubagents.add(subagent);
    if (label) labeledSubagents.add(subagent);
}

/** B-628: `completed` / `failed` / `interrupted` as the session protocol's stop status. */
function subagentStopStatus(status: unknown): 'completed' | 'failed' | 'stopped' {
    if (status === 'failed') return 'failed';
    if (status === 'interrupted' || status === 'cancelled' || status === 'canceled' || status === 'aborted') return 'stopped';
    return 'completed';
}

function emitSubagentStops(
    opts: CreateEnvelopeOptions,
    startedSubagents: Set<string>,
    activeSubagents: Set<string>,
): SessionEnvelope[] {
    const envelopes: SessionEnvelope[] = [];
    for (const subagent of activeSubagents) {
        envelopes.push(createEnvelope('agent', { t: 'stop' }, { ...opts, subagent }));
    }
    activeSubagents.clear();
    startedSubagents.clear();
    return envelopes;
}

function buildEnvelopeOptions(currentTurnId: string | null, subagent?: string): CreateEnvelopeOptions {
    return {
        ...(currentTurnId ? { turn: currentTurnId } : {}),
        ...(subagent ? { subagent } : {}),
    };
}

function pickProviderSubagent(message: Record<string, unknown>): string | undefined {
    const candidates = [message.subagent, message.parent_call_id, message.parentCallId];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.length > 0) {
            return candidate;
        }
    }
    return undefined;
}

/** B-628: the name the app-server client attached to a child thread's item (codexChildThreads.ts). */
function pickSubagentLabel(message: Record<string, unknown>): string | undefined {
    const label = message.subagent_label;
    return typeof label === 'string' && label.length > 0 ? label : undefined;
}

function resolveSessionSubagent(
    message: Record<string, unknown>,
    providerSubagentToSessionSubagent: Map<string, string>,
): string | undefined {
    const providerSubagent = pickProviderSubagent(message);
    if (!providerSubagent) {
        return undefined;
    }

    const existing = providerSubagentToSessionSubagent.get(providerSubagent);
    if (existing) {
        return existing;
    }

    const created = createId();
    providerSubagentToSessionSubagent.set(providerSubagent, created);
    return created;
}

function pickCallId(message: Record<string, unknown>): string {
    const callId = message.call_id ?? message.callId;
    if (typeof callId === 'string' && callId.length > 0) {
        return callId;
    }
    return randomUUID();
}

function summarizeCommand(command: unknown): string | null {
    if (typeof command === 'string' && command.trim().length > 0) {
        return command;
    }
    if (Array.isArray(command)) {
        const cmd = command.map(v => String(v)).join(' ').trim();
        return cmd.length > 0 ? cmd : null;
    }
    return null;
}

function commandToTitle(command: string | null): string {
    if (!command) {
        return 'Run command';
    }
    const short = command.length > 80 ? `${command.slice(0, 77)}...` : command;
    return `Run \`${short}\``;
}

function turnTimestampMs(turn: ThreadTurn): number {
    const seconds = turn.startedAt ?? turn.completedAt;
    return typeof seconds === 'number' && Number.isFinite(seconds)
        ? seconds * 1000
        : Date.now();
}

function completedTimestampMs(turn: ThreadTurn): number {
    const seconds = turn.completedAt ?? turn.startedAt;
    return typeof seconds === 'number' && Number.isFinite(seconds)
        ? seconds * 1000
        : Date.now();
}

function textFromInputItems(items: unknown): string | null {
    if (!Array.isArray(items)) {
        return null;
    }
    const text = items
        .filter((item): item is { type: 'text'; text: string } => (
            Boolean(item)
            && typeof item === 'object'
            && (item as { type?: unknown }).type === 'text'
            && typeof (item as { text?: unknown }).text === 'string'
        ))
        .map((item) => item.text)
        .join('\n')
        .trim();
    return text.length > 0 ? text : null;
}

function reasoningText(item: ThreadItem): string | null {
    const summary = (item as { summary?: unknown }).summary;
    const content = (item as { content?: unknown }).content;
    const parts = [
        ...(Array.isArray(summary) ? summary : []),
        ...(Array.isArray(content) ? content : []),
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    const text = parts.join('\n').trim();
    return text.length > 0 ? text : null;
}

function turnStatus(turn: ThreadTurn): TurnEndStatus {
    const status = typeof turn.status === 'string' ? turn.status : null;
    if (status === 'failed') {
        return 'failed';
    }
    if (status === 'cancelled' || status === 'canceled' || status === 'aborted' || status === 'interrupted') {
        return 'cancelled';
    }
    return 'completed';
}

/** B-771: a Codex command failed when it exited non-zero or never ran. */
function commandFailed(exitCode: unknown, status: unknown): boolean {
    return (typeof exitCode === 'number' && exitCode !== 0) || status === 'failed' || status === 'declined';
}

/** Card result for a live `exec_command_end` (aggregatedOutput + exit code). */
function commandResult(message: Record<string, unknown>) {
    // App-server `output`; the legacy `codex mcp` event named it `aggregated_output`.
    const raw = [message.output, message.aggregated_output, message.formatted_output].find((v) => typeof v === 'string');
    const output = typeof raw === 'string' ? raw : '';
    const exitCode = message.exit_code;
    const failed = commandFailed(exitCode, message.status);
    const text = typeof exitCode === 'number' && exitCode !== 0
        ? `${output}${output === '' || output.endsWith('\n') ? '' : '\n'}[exit code ${exitCode}]`
        : output;
    return textResultPayload(text, failed);
}

function errorText(error: unknown): string {
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') return (error as { message: string }).message;
    return JSON.stringify(error) ?? String(error);
}

/** MCP `CallToolResult` → text (content blocks, else structured JSON); never "[object Object]". */
function mcpResultText(result: unknown): string | null {
    if (result === undefined || result === null) return null;
    if (typeof result === 'string') return result;
    const content = (result as { content?: unknown }).content;
    const text = Array.isArray(content) ? toolResultContentText(content) : '';
    if (text) return text;
    const structured = (result as { structuredContent?: unknown }).structuredContent;
    return JSON.stringify(structured ?? result, null, 2) ?? null;
}

function emitHistoricalToolCall(
    envelopes: SessionEnvelope[],
    turn: ThreadTurn,
    item: ThreadItem,
    name: string,
    title: string,
    args: Record<string, unknown>,
    output: string | null,
    isError = false,
): void {
    const time = turnTimestampMs(turn);
    const opts = { turn: turn.id, time, codexItemId: item.id } satisfies CreateEnvelopeOptions;
    envelopes.push(createEnvelope('agent', {
        t: 'tool-call-start',
        call: item.id,
        name,
        title,
        description: title,
        args,
    }, {
        ...opts,
        id: `${item.id}:start`,
    }));

    const running = 'status' in item && (item.status === 'inProgress' || item.status === 'running');
    // B-771: a finished call's output belongs on its card (tool-call-end.result);
    // only a still-running call keeps it as a reasoning line, since it has no end yet.
    if (running) {
        if (output && output.trim().length > 0) {
            envelopes.push(createEnvelope('agent', {
                t: 'text',
                text: output,
                thinking: true,
            }, {
                ...opts,
                id: `${item.id}:output`,
            }));
        }
        return;
    }

    const result = textResultPayload(output ?? '', isError);
    envelopes.push(createEnvelope('agent', {
        t: 'tool-call-end',
        call: item.id,
        ...(result ? { result } : {}),
    }, {
        ...opts,
        id: `${item.id}:end`,
        time: completedTimestampMs(turn),
    }));
}

/** Preserve native collaboration calls. Completion here is the control call,
 * never an inferred child-agent completion. agentsStates remain reported snapshots. */
export function mapCodexCollaborationItem(item: Record<string, unknown>, opts: CreateEnvelopeOptions = {}, source: 'live' | 'history' = 'history'): SessionEnvelope[] {
    if (item.type === 'subAgentActivity' && typeof item.agentThreadId === 'string') {
        item = {...item,type:'collabAgentToolCall',tool:item.kind,status:'completed',receiverThreadIds:[item.agentThreadId]};
    }
    if (item.type !== 'collabAgentToolCall' || typeof item.id !== 'string' || typeof item.tool !== 'string') return [];
    const args = {
        operation: item.tool,
        ...(typeof item.prompt === 'string' ? { prompt: item.prompt } : {}),
        ...(typeof item.model === 'string' ? { model: item.model } : {}),
        receiverThreadIds: Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [],
        agentsStates: item.agentsStates ?? {},
    };
    // A completed notification fills in receivers and agent snapshots that
    // may be absent at start. Keep the tool-call identity, but use a distinct
    // message identity so incremental reducers do not discard that update.
    const startId = source === 'live' ? `${item.id}:${item.status ?? 'unknown'}:start` : `${item.id}:start`;
    const envelopes = [createEnvelope('agent', {
        t:'tool-call-start',call:item.id,name:'CodexCollaboration',title:`Codex · ${item.tool}`,description:`Codex · ${item.tool}`,args,
    }, {...opts, id:startId})];
    if (item.status === 'completed' || item.status === 'failed' || item.status === 'interrupted') {
        envelopes.push(createEnvelope('agent', {t:'tool-call-end',call:item.id,
            result:{text:JSON.stringify(args,null,2),isError:item.status !== 'completed'}}, {...opts,id:`${item.id}:end`}));
    }
    return envelopes;
}

export function mapCodexThreadToSessionEnvelopes(thread: Pick<Thread, 'turns'>): SessionEnvelope[] {
    const envelopes: SessionEnvelope[] = [];

    for (const turn of thread.turns ?? []) {
        const startedAt = turnTimestampMs(turn);
        const completedAt = completedTimestampMs(turn);
        envelopes.push(createEnvelope('agent', { t: 'turn-start' }, {
            id: `${turn.id}:start`,
            turn: turn.id,
            time: startedAt,
        }));

        for (const item of turn.items ?? []) {
            switch (item.type) {
                case 'subAgentActivity':
                case 'collabAgentToolCall': {
                    envelopes.push(...mapCodexCollaborationItem(item, {turn:turn.id,time:startedAt,codexItemId:item.id}));
                    break;
                }
                case 'userMessage': {
                    const text = textFromInputItems(item.content);
                    if (text) {
                        envelopes.push(createEnvelope('user', { t: 'text', text }, {
                            id: item.id,
                            time: startedAt,
                            codexItemId: item.id,
                        }));
                    }
                    break;
                }
                case 'agentMessage': {
                    const text = typeof item.text === 'string' ? item.text.trim() : '';
                    if (text.length > 0) {
                        envelopes.push(createEnvelope('agent', { t: 'text', text }, {
                            id: item.id,
                            turn: turn.id,
                            time: completedAt,
                            codexItemId: item.id,
                        }));
                    }
                    break;
                }
                case 'reasoning': {
                    const text = reasoningText(item);
                    if (text) {
                        envelopes.push(createEnvelope('agent', { t: 'text', text, thinking: true }, {
                            id: item.id,
                            turn: turn.id,
                            time: startedAt,
                            codexItemId: item.id,
                        }));
                    }
                    break;
                }
                case 'commandExecution': {
                    const command = typeof item.command === 'string' ? item.command : '';
                    emitHistoricalToolCall(
                        envelopes,
                        turn,
                        item,
                        'CodexBash',
                        commandToTitle(command),
                        { command, cwd: item.cwd },
                        typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : null,
                        commandFailed(item.exitCode, item.status),
                    );
                    break;
                }
                case 'fileChange': {
                    const title = 'Apply patch';
                    emitHistoricalToolCall(
                        envelopes,
                        turn,
                        item,
                        'CodexPatch',
                        title,
                        { changes: item.changes, status: item.status },
                        null,
                    );
                    break;
                }
                case 'mcpToolCall': {
                    const title = `${item.server}.${item.tool}`;
                    const failed = item.error !== undefined && item.error !== null;
                    const output = failed ? errorText(item.error) : mcpResultText(item.result);
                    emitHistoricalToolCall(
                        envelopes,
                        turn,
                        item,
                        'McpTool',
                        title,
                        {
                            server: item.server,
                            tool: item.tool,
                            arguments: item.arguments,
                        },
                        output,
                        failed,
                    );
                    break;
                }
            }
        }

        envelopes.push(createEnvelope('agent', { t: 'turn-end', status: turnStatus(turn) }, {
            id: `${turn.id}:end`,
            turn: turn.id,
            time: completedAt,
        }));
    }

    return envelopes;
}

function patchDescription(changes: unknown): string {
    if (!changes || typeof changes !== 'object') {
        return 'Applying patch';
    }
    const fileCount = Object.keys(changes as Record<string, unknown>).length;
    if (fileCount === 1) {
        return 'Applying patch to 1 file';
    }
    return `Applying patch to ${fileCount} files`;
}

function pickTurnEndStatus(message: Record<string, unknown>, type: unknown): TurnEndStatus {
    const rawStatus = message.status;
    if (rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'cancelled') {
        return rawStatus;
    }
    if (rawStatus === 'canceled') {
        return 'cancelled';
    }

    // Abort events are treated as cancelled unless they explicitly look like failures.
    if (type === 'turn_aborted') {
        const reason = message.reason;
        const error = message.error;
        if ((typeof reason === 'string' && /(fail|error)/i.test(reason))
            || (typeof error === 'string' && error.length > 0)
            || (error !== undefined && error !== null && typeof error === 'object')) {
            return 'failed';
        }
        return 'cancelled';
    }

    if (message.error !== undefined && message.error !== null) {
        return 'failed';
    }

    return 'completed';
}

export function mapCodexMcpMessageToSessionEnvelopes(message: Record<string, unknown>, state: CodexTurnState): CodexMapperResult {
    const type = message.type;
    const startedSubagents = getStartedSubagents(state);
    const activeSubagents = getActiveSubagents(state);
    const providerSubagentToSessionSubagent = getProviderSubagentToSessionSubagent(state);
    const labeledSubagents = getLabeledSubagents(state);

    if (type === 'collab_agent_item') {
        // B-628: a collab call a child thread makes (a grandchild's spawn) nests under the child's card.
        const subagent = resolveSessionSubagent(message, providerSubagentToSessionSubagent);
        const opts = buildEnvelopeOptions(state.currentTurnId, subagent);
        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, envelopes, pickSubagentLabel(message), labeledSubagents);
        envelopes.push(...mapCodexCollaborationItem(message.item as Record<string, unknown>, opts, 'live'));
        return {currentTurnId:state.currentTurnId, startedSubagents, activeSubagents, providerSubagentToSessionSubagent, labeledSubagents, envelopes};
    }

    if (type === 'subagent_turn_end') {
        // B-628: a child thread's own `turn/completed` ends its card now, not only when the
        // parent's turn ends (emitSubagentStops). A later turn of the same child (send_input)
        // starts the card again under the same session sub-agent id.
        const providerSubagent = pickProviderSubagent(message);
        const sessionSubagent = providerSubagent ? providerSubagentToSessionSubagent.get(providerSubagent) : undefined;
        const envelopes: SessionEnvelope[] = [];
        if (sessionSubagent && activeSubagents.has(sessionSubagent)) {
            envelopes.push(createEnvelope('agent', { t: 'stop', status: subagentStopStatus(message.status) }, buildEnvelopeOptions(state.currentTurnId, sessionSubagent)));
            activeSubagents.delete(sessionSubagent);
            startedSubagents.delete(sessionSubagent);
        }
        return { currentTurnId: state.currentTurnId, startedSubagents, activeSubagents, providerSubagentToSessionSubagent, labeledSubagents, envelopes };
    }

    if (type === 'task_started') {
        const turnId = createId();
        const turnStart = createEnvelope('agent', { t: 'turn-start' }, { turn: turnId });
        startedSubagents.clear();
        activeSubagents.clear();
        providerSubagentToSessionSubagent.clear();
        labeledSubagents.clear();
        return {
            currentTurnId: turnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            labeledSubagents,
            envelopes: [turnStart],
        };
    }

    if (type === 'task_complete' || type === 'turn_aborted') {
        if (!state.currentTurnId) {
            return {
                currentTurnId: null,
                startedSubagents,
                activeSubagents,
                providerSubagentToSessionSubagent,
                labeledSubagents,
                envelopes: [],
            };
        }

        const lifecycleOpts = { turn: state.currentTurnId } satisfies CreateEnvelopeOptions;
        providerSubagentToSessionSubagent.clear();
        labeledSubagents.clear();
        return {
            currentTurnId: null,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            labeledSubagents,
            envelopes: [
                ...emitSubagentStops(lifecycleOpts, startedSubagents, activeSubagents),
                createEnvelope('agent', {
                    t: 'turn-end',
                    status: pickTurnEndStatus(message, type),
                }, lifecycleOpts),
            ],
        };
    }

    if (type === 'token_count') {
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            labeledSubagents,
            envelopes: [],
        };
    }

    const subagent = resolveSessionSubagent(message, providerSubagentToSessionSubagent);
    const opts = buildEnvelopeOptions(state.currentTurnId, subagent);

    if (type === 'agent_message') {
        if (typeof message.message !== 'string') {
            return {
                currentTurnId: state.currentTurnId,
                startedSubagents,
                activeSubagents,
                providerSubagentToSessionSubagent,
                labeledSubagents,
                envelopes: [],
            };
        }

        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, envelopes, pickSubagentLabel(message), labeledSubagents);
        envelopes.push(createEnvelope('agent', { t: 'text', text: message.message }, opts));
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            labeledSubagents,
            envelopes,
        };
    }

    if (type === 'agent_reasoning' || type === 'agent_reasoning_delta') {
        const text = typeof message.text === 'string'
            ? message.text
            : (typeof message.delta === 'string' ? message.delta : null);

        if (!text) {
            return {
                currentTurnId: state.currentTurnId,
                startedSubagents,
                activeSubagents,
                providerSubagentToSessionSubagent,
                labeledSubagents,
                envelopes: [],
            };
        }

        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, envelopes, pickSubagentLabel(message), labeledSubagents);
        envelopes.push(createEnvelope('agent', { t: 'text', text, thinking: true }, opts));
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            labeledSubagents,
            envelopes,
        };
    }

    // exec_approval_request is intentionally NOT mapped here — the permission
    // handler already renders the approval UI via agent state.  Mapping it to
    // tool-call-start too would create a duplicate tool call card.
    if (type === 'exec_command_begin') {
        const call = pickCallId(message);
        const { call_id: _callIdSnake, callId: _callIdCamel, type: _type, ...args } = message;

        const command = summarizeCommand((args as Record<string, unknown>).command);
        const description = typeof (args as Record<string, unknown>).description === 'string'
            ? ((args as Record<string, string>).description)
            : (command ?? 'Execute command');

        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, envelopes, pickSubagentLabel(message), labeledSubagents);
        envelopes.push(
            createEnvelope('agent', {
                t: 'tool-call-start',
                call,
                name: 'CodexBash',
                title: commandToTitle(command),
                description,
                args: args as Record<string, unknown>,
            }, opts)
        );
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            labeledSubagents,
            envelopes,
        };
    }

    if (type === 'exec_command_end') {
        const call = pickCallId(message);
        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, envelopes, pickSubagentLabel(message), labeledSubagents);
        // B-771: the command's output reaches the card (it used to be dropped here).
        const result = commandResult(message);
        envelopes.push(createEnvelope('agent', { t: 'tool-call-end', call, ...(result ? { result } : {}) }, opts));
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            labeledSubagents,
            envelopes,
        };
    }

    if (type === 'patch_apply_begin') {
        const call = pickCallId(message);
        const autoApproved = (message as { auto_approved?: unknown }).auto_approved;
        const changes = (message as { changes?: unknown }).changes;

        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, envelopes, pickSubagentLabel(message), labeledSubagents);
        envelopes.push(
            createEnvelope('agent', {
                t: 'tool-call-start',
                call,
                name: 'CodexPatch',
                title: 'Apply patch',
                description: patchDescription(changes),
                args: {
                    auto_approved: autoApproved,
                    changes,
                },
            }, opts)
        );
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            labeledSubagents,
            envelopes,
        };
    }

    if (type === 'patch_apply_end') {
        const call = pickCallId(message);
        const envelopes: SessionEnvelope[] = [];
        maybeEmitSubagentStart(subagent, opts, startedSubagents, activeSubagents, envelopes, pickSubagentLabel(message), labeledSubagents);
        envelopes.push(createEnvelope('agent', { t: 'tool-call-end', call }, opts));
        return {
            currentTurnId: state.currentTurnId,
            startedSubagents,
            activeSubagents,
            providerSubagentToSessionSubagent,
            labeledSubagents,
            envelopes,
        };
    }

    return {
        currentTurnId: state.currentTurnId,
        startedSubagents,
        activeSubagents,
        providerSubagentToSessionSubagent,
        labeledSubagents,
        envelopes: [],
    };
}

export function mapCodexProcessorMessageToSessionEnvelopes(
    message: ReasoningOutput | DiffToolCall | DiffToolResult,
    state: CodexTurnState,
): SessionEnvelope[] {
    const toolLikeMessage = message as LegacyToolLikeMessage;
    const opts = buildEnvelopeOptions(state.currentTurnId);

    if (message.type === 'reasoning') {
        return [createEnvelope('agent', {
            t: 'text',
            text: message.message,
            thinking: true,
        }, opts)];
    }

    if (message.type === 'tool-call') {
        const title = typeof (toolLikeMessage.input as { title?: unknown } | undefined)?.title === 'string'
            ? (toolLikeMessage.input as { title: string }).title
            : `${toolLikeMessage.name || 'Tool'} call`;

        return [createEnvelope('agent', {
            t: 'tool-call-start',
            call: toolLikeMessage.callId,
            name: toolLikeMessage.name || 'unknown',
            title,
            description: title,
            args: (toolLikeMessage.input && typeof toolLikeMessage.input === 'object'
                ? toolLikeMessage.input
                : {}) as Record<string, unknown>,
        }, opts)];
    }

    if (message.type === 'tool-call-result') {
        const envelopes: SessionEnvelope[] = [];
        const content = toolLikeMessage.output?.content;
        if (typeof content === 'string' && content.trim().length > 0) {
            envelopes.push(createEnvelope('agent', {
                t: 'text',
                text: content,
                thinking: true,
            }, opts));
        }
        envelopes.push(createEnvelope('agent', {
            t: 'tool-call-end',
            call: toolLikeMessage.callId,
        }, opts));
        return envelopes;
    }

    return [];
}
