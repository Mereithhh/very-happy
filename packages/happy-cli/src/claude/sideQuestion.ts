/**
 * Side questions (`/btw`, B-283) — a quick question answered from the main
 * conversation's context WITHOUT touching the main conversation.
 *
 * Mirrors Claude Code's own `/btw`: the answer comes from a separate,
 * single-turn query that forks the live Claude session (so it sees the same
 * transcript), can't use tools, and is never persisted. The main Query keeps
 * running untouched — a side question may be asked mid-turn.
 *
 * Everything here is deliberately pure/injectable: `query` is a parameter so
 * unit tests drive the message stream without the SDK.
 */
import type { QueryOptions, QueryPrompt, SDKMessage } from '@/claude/sdk/types';

export interface SideQuestionExchange {
    question: string;
    answer: string;
}

export interface SideQuestionInput {
    question: string;
    /** Earlier side questions of this session (web-held; CLI keeps nothing). */
    history?: SideQuestionExchange[];
    /** Live Claude session id to fork; null before the first turn (no context). */
    resumeSessionId: string | null;
    cwd: string;
    model?: string;
    /** Session `--claude-env` values (provider/base URL/managed flag) — the fork must see the same. */
    env?: Record<string, string>;
    /** Settings file that disables hooks: a side question must not fire the user's SessionStart/Stop hooks. */
    settingsPath?: string;
    signal?: AbortSignal;
    /** Progressive text — the full answer so far, every time it grows. */
    onText?: (text: string) => void;
}

export interface SideQuestionResult {
    answer: string;
    /** Whether the fork actually carried the main conversation's context. */
    hadContext: boolean;
    /** 'live' = answered inside the running Claude process (B-482); 'fork' = separate query over the transcript. */
    mode?: SideQuestionMode;
}

export type SideQuestionMode = 'live' | 'fork';

/**
 * B-482 — the in-process path. Claude Code's own `/btw` is a `side_question`
 * control request handled by the running `claude` process (the same chain
 * that serves `interrupt` / `set_model` over the SDK's stdio channel; the
 * Remote Control thin client uses exactly this). The process answers from its
 * LIVE messages — including the turn in flight — with its own reminder, fork,
 * no-tools policy and synthetic notices, so the behaviour is Claude Code's
 * verbatim. The SDK types don't list the subtype; `Query.request()` sends it
 * untyped. Progress (`system/control_request_progress`) is not consumed here.
 */
export interface SideQuestionLiveRequest {
    question: string;
    /** Claude Code's `btwHistory` shape: `response`, not `answer`. */
    history?: { question: string; response: string; fallback_notice?: string }[];
}
export interface SideQuestionLiveResponse {
    /** null when the process answered nothing (aborted); text otherwise, possibly a synthetic notice. */
    response: string | null;
    synthetic?: boolean;
    refusal_fallback?: { original_model?: string; fallback_model?: string; content?: string };
}
export type SideQuestionLiveAsk = (request: SideQuestionLiveRequest, signal?: AbortSignal) => Promise<SideQuestionLiveResponse>;
/** What the launcher hands over while a remote Query is alive (null between Queries / in local mode). */
export interface SideQuestionLiveQuery {
    ask: SideQuestionLiveAsk;
    /** 铁律 8: no control request while the wrapper sits inside an SDK callback. */
    canControl: () => boolean;
}

/** True for the CLI's "I don't know this control request" verdicts — the caller then falls back to the fork. */
export function isUnsupportedSideQuestionError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /unknown|unsupported|not supported|unrecognized|invalid.*subtype/i.test(message);
}

export async function runSideQuestionLive(ask: SideQuestionLiveAsk, input: SideQuestionInput): Promise<SideQuestionResult> {
    const history = (input.history ?? [])
        .filter((h) => h.question.trim() && h.answer.trim())
        .slice(-MAX_HISTORY)
        .map((h) => ({ question: clip(h.question.trim(), MAX_HISTORY_CHARS), response: clip(h.answer.trim(), MAX_HISTORY_CHARS) }));
    const result = await ask({ question: input.question.trim(), ...(history.length ? { history } : {}) }, input.signal);
    if (input.signal?.aborted) throw new Error('Side question cancelled');
    const text = typeof result?.response === 'string' ? result.response : '';
    if (!text.trim()) throw new Error('Side question ended without a result');
    const fallback = result.refusal_fallback?.content;
    const answer = fallback ? `⚠ ${fallback}\n\n${text}` : text;
    input.onText?.(answer);
    return { answer, hadContext: true, mode: 'live' };
}

type QueryFn = (params: { prompt: QueryPrompt; options?: QueryOptions }) => AsyncIterable<SDKMessage>;

/**
 * Short system-prompt tail; the real steering lives in `SIDE_QUESTION_REMINDER`
 * inside the user turn. 2026-09-22 (Yue DENG's report): with only this append,
 * a fork asked "现在在干嘛呢" answered like the MAIN agent — "现在真的起："
 * then stopped dead, because it went to call a tool it does not have. A system
 * prompt tail is too far from the question to beat a transcript full of the
 * agent doing things; Claude Code's own `/btw` puts the reminder in the user
 * message, right before the question, and so do we now.
 */
export const SIDE_QUESTION_SYSTEM_PROMPT = [
    'A user message wrapped in a side-question system-reminder is a SIDE QUESTION: answer it',
    'directly in one response from the conversation context, with no tools and no action on the main task.',
].join(' ');

/**
 * Verbatim wording of Claude Code 2.1.x's `/btw` reminder (the one the model
 * has been tuned against). Kept in one place so a test pins the clauses that
 * matter: separate instance, no tools, no "let me check" promises.
 */
export const SIDE_QUESTION_REMINDER = [
    '<system-reminder>This is a side question from the user. You must answer this question directly in a single response.',
    '',
    'IMPORTANT CONTEXT:',
    '- You are a separate, lightweight agent spawned to answer this one question',
    '- The main agent is NOT interrupted - it continues working independently in the background',
    '- You share the conversation context but are a completely separate instance',
    '- Do NOT reference being interrupted or what you were "previously doing" - that framing is incorrect',
    '',
    'CRITICAL CONSTRAINTS:',
    '- You have NO tools available - you cannot read files, run commands, search, or take any actions',
    '- This is a one-off response - there will be no follow-up turns',
    '- You can ONLY provide information based on what you already know from the conversation context',
    '- NEVER say things like "Let me try...", "I\'ll now...", "Let me check...", or promise to take any action',
    '- If you don\'t know the answer, say so - do not offer to look it up or investigate',
    '',
    'Simply answer the question with the information you have.</system-reminder>',
].join('\n');

export const MAX_HISTORY = 12;
export const MAX_HISTORY_CHARS = 2000;

function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Prompt for one side question. Earlier exchanges ride along as plain text
 * (the fork's transcript never contains them — like the CLI's in-memory
 * `btwHistory`), bounded so a long chat can't crowd out the question. The
 * reminder sits directly before the question, after the history block, so it
 * is the last instruction the model reads.
 */
export function buildSideQuestionPrompt(question: string, history: SideQuestionExchange[] = []): string {
    const trimmed = question.trim();
    const prior = history
        .filter((h) => h.question.trim() && h.answer.trim())
        .slice(-MAX_HISTORY);
    const body = `${SIDE_QUESTION_REMINDER}\n\n${trimmed}`;
    if (prior.length === 0) return body;
    const lines = prior.map((h) => `Q: ${clip(h.question.trim(), MAX_HISTORY_CHARS)}\nA: ${clip(h.answer.trim(), MAX_HISTORY_CHARS)}`);
    return `<earlier-side-questions>\n${lines.join('\n\n')}\n</earlier-side-questions>\n\n${body}`;
}

/** Options for the side query — exported so tests can pin the contract. */
export function sideQuestionQueryOptions(input: SideQuestionInput): QueryOptions {
    return {
        cwd: input.cwd,
        ...(input.resumeSessionId ? { resume: input.resumeSessionId, forkSession: true } : {}),
        persistSession: false,
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        maxTurns: 1,
        includePartialMessages: true,
        permissionMode: 'default',
        model: input.model,
        env: input.env,
        settingsPath: input.settingsPath,
        appendSystemPrompt: SIDE_QUESTION_SYSTEM_PROMPT,
        canCallTool: async () => ({ behavior: 'deny', message: 'Side questions cannot use tools' }),
        abort: input.signal,
    };
}

function assistantBlocks(message: SDKMessage): { type?: string; text?: unknown; name?: unknown }[] {
    if (message.type !== 'assistant') return [];
    const content = (message as { message?: { content?: unknown } }).message?.content;
    return Array.isArray(content) ? content.filter((b): b is { type?: string } => Boolean(b) && typeof b === 'object') : [];
}

function textFromAssistant(message: SDKMessage): string {
    return assistantBlocks(message)
        .map((block) => (block.type === 'text' ? String(block.text ?? '') : ''))
        .join('');
}

function toolUseFromAssistant(message: SDKMessage): string | null {
    const block = assistantBlocks(message).find((b) => b.type === 'tool_use');
    return block ? String(block.name ?? 'a tool') : null;
}

/** Same fallback Claude Code shows when the fork reaches for a tool instead of answering. */
export function toolAttemptNotice(toolName: string): string {
    return `(The model tried to call ${toolName} instead of answering directly. Try rephrasing or ask in the main conversation.)`;
}

function apiErrorFromSystem(message: SDKMessage): string | null {
    if (message.type !== 'system') return null;
    const m = message as { subtype?: string; error?: { formatted?: unknown; message?: unknown } | string };
    if (m.subtype !== 'api_error') return null;
    if (typeof m.error === 'string') return m.error;
    const detail = m.error?.formatted ?? m.error?.message;
    return typeof detail === 'string' && detail ? detail : 'API error';
}

export async function runSideQuestion(query: QueryFn, input: SideQuestionInput): Promise<SideQuestionResult> {
    const options = sideQuestionQueryOptions(input);
    const stream = query({ prompt: buildSideQuestionPrompt(input.question, input.history), options });
    let streamed = '';
    let final = '';
    let toolAttempt: string | null = null;
    let lastApiError: string | null = null;
    let resultSeen = false;
    for await (const message of stream) {
        if (message.type === 'stream_event') {
            const event = (message as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
            if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
                streamed += event.delta.text;
                input.onText?.(streamed);
            }
            continue;
        }
        if (message.type === 'assistant') {
            const text = textFromAssistant(message);
            if (text) {
                final = final ? `${final}\n\n${text}` : text;
                input.onText?.(final);
            }
            toolAttempt ??= toolUseFromAssistant(message);
            continue;
        }
        if (message.type === 'system') {
            lastApiError = apiErrorFromSystem(message) ?? lastApiError;
            continue;
        }
        if (message.type === 'result') {
            resultSeen = true;
            const result = message as { subtype?: string; errors?: unknown; result?: unknown };
            if (result.subtype !== 'success') {
                // maxTurns:1 ends in error_max_turns when the model emitted a
                // tool_use; that is not a failure to report, it is the notice below.
                if (toolAttempt && result.subtype === 'error_max_turns') break;
                const detail = Array.isArray(result.errors) && result.errors.length > 0
                    ? String(result.errors[0])
                    : typeof result.result === 'string' && result.result
                        ? result.result
                        : lastApiError ?? result.subtype ?? 'unknown';
                throw new Error(`Side question failed: ${detail}`);
            }
            if (!final && typeof result.result === 'string') final = result.result;
        }
    }
    if (input.signal?.aborted) throw new Error('Side question cancelled');
    if (toolAttempt && !final.trim() && !streamed.trim()) {
        const notice = toolAttemptNotice(toolAttempt);
        input.onText?.(notice);
        return { answer: notice, hadContext: Boolean(input.resumeSessionId), mode: 'fork' };
    }
    if (!resultSeen && !final && !streamed) throw new Error(`Side question ended without a result${lastApiError ? `: ${lastApiError}` : ''}`);
    return { answer: final || streamed, hadContext: Boolean(input.resumeSessionId), mode: 'fork' };
}
