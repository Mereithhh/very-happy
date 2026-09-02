/**
 * Side questions (`/btw`, B-282) — a quick question answered from the main
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
    signal?: AbortSignal;
    /** Progressive text — the full answer so far, every time it grows. */
    onText?: (text: string) => void;
}

export interface SideQuestionResult {
    answer: string;
    /** Whether the fork actually carried the main conversation's context. */
    hadContext: boolean;
}

type QueryFn = (params: { prompt: QueryPrompt; options?: QueryOptions }) => AsyncIterable<SDKMessage>;

/** Same contract Claude Code's `/btw` injects as a system reminder. */
export const SIDE_QUESTION_SYSTEM_PROMPT = [
    'This is a SIDE QUESTION from the user, asked next to the main conversation above.',
    'Answer it directly in a single response, using the conversation context and your own knowledge.',
    'Side questions cannot use tools: do not attempt to read files, run commands, or call tools — if',
    'the answer would require that, say what you would check and why.',
    'Do NOT continue, resume, or reference progress on the main task; the main conversation is',
    'unaffected by this exchange.',
].join(' ');

const MAX_HISTORY = 12;
const MAX_HISTORY_CHARS = 2000;

function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Prompt for one side question. Earlier exchanges ride along as plain text
 * (the fork's transcript never contains them — like the CLI's in-memory
 * `btwHistory`), bounded so a long chat can't crowd out the question.
 */
export function buildSideQuestionPrompt(question: string, history: SideQuestionExchange[] = []): string {
    const trimmed = question.trim();
    const prior = history
        .filter((h) => h.question.trim() && h.answer.trim())
        .slice(-MAX_HISTORY);
    if (prior.length === 0) return trimmed;
    const lines = prior.map((h) => `Q: ${clip(h.question.trim(), MAX_HISTORY_CHARS)}\nA: ${clip(h.answer.trim(), MAX_HISTORY_CHARS)}`);
    return `<earlier-side-questions>\n${lines.join('\n\n')}\n</earlier-side-questions>\n\n${trimmed}`;
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
        appendSystemPrompt: SIDE_QUESTION_SYSTEM_PROMPT,
        canCallTool: async () => ({ behavior: 'deny', message: 'Side questions cannot use tools' }),
        abort: input.signal,
    };
}

function textFromAssistant(message: SDKMessage): string {
    if (message.type !== 'assistant') return '';
    const content = (message as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) return '';
    return content
        .map((block) => (block && typeof block === 'object' && (block as { type?: string }).type === 'text'
            ? String((block as { text?: unknown }).text ?? '')
            : ''))
        .join('');
}

export async function runSideQuestion(query: QueryFn, input: SideQuestionInput): Promise<SideQuestionResult> {
    const options = sideQuestionQueryOptions(input);
    const stream = query({ prompt: buildSideQuestionPrompt(input.question, input.history), options });
    let streamed = '';
    let final = '';
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
            continue;
        }
        if (message.type === 'result') {
            resultSeen = true;
            const result = message as { subtype?: string; errors?: unknown; result?: unknown };
            if (result.subtype !== 'success') {
                const detail = Array.isArray(result.errors) && result.errors.length > 0
                    ? String(result.errors[0])
                    : typeof result.result === 'string' && result.result
                        ? result.result
                        : result.subtype ?? 'unknown';
                throw new Error(`Side question failed: ${detail}`);
            }
            if (!final && typeof result.result === 'string') final = result.result;
        }
    }
    if (input.signal?.aborted) throw new Error('Side question cancelled');
    if (!resultSeen && !final && !streamed) throw new Error('Side question ended without a result');
    return { answer: final || streamed, hadContext: Boolean(input.resumeSessionId) };
}
