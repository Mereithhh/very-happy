/**
 * B-861 — `/btw` side questions for Codex sessions.
 *
 * Same contract as the Claude fork path (`claude/sideQuestion.ts`): answered
 * from the main conversation's context, single turn, no tools, nothing
 * written to the main thread. Codex has no in-process side channel, so the
 * wrapper starts a SECOND app-server (same account overrides, so an
 * account-bound session never falls back to the machine login), forks the
 * main thread into an EPHEMERAL thread (never persisted — no rollout file),
 * runs one turn there and stops that app-server. The main app-server and its
 * turn are never touched.
 *
 * Probed on Codex 0.154 (vh-team-B-861/codex-probe1.log, codex-probe2.log):
 * the fork works while the main turn runs — including the very first turn —
 * carrying the turn in flight as `interrupted`; the main turn completes and
 * its rollout only grows by its own lines; no session file appears.
 */
import { buildSideQuestionPrompt, SIDE_QUESTION_SYSTEM_PROMPT, toolAttemptNotice, type SideQuestionInput, type SideQuestionResult } from '@/claude/sideQuestion';

/** The slice of `CodexAppServerClient` a side question needs (a fresh client per question). */
export interface CodexSideClient {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    onRawNotification(listener: (method: string, params: any) => void): () => void;
    openSideThread(opts: { sourceThreadId: string | null; cwd: string; model?: string; developerInstructions: string }): Promise<{ threadId: string }>;
    startSideTurn(threadId: string, text: string): Promise<string | null>;
    interruptSideTurn(threadId: string, turnId: string): Promise<void>;
}

/**
 * Developer instructions of the side thread. Codex shows the main turn in
 * the fork as interrupted; the shared prompt says what is true (probe 1:
 * "the agent was interrupted while waiting for X").
 */
export const CODEX_SIDE_QUESTION_INSTRUCTIONS = `${SIDE_QUESTION_SYSTEM_PROMPT} Do not run commands or call tools.`;

/** Item types of a plain answer; anything else is the model reaching for a tool. */
const ANSWER_ITEMS = new Set(['userMessage', 'agentMessage', 'reasoning']);

function toolName(item: { type?: unknown; command?: unknown; tool?: unknown; server?: unknown }): string {
    if (item.type === 'commandExecution') return 'a shell command';
    if (item.type === 'mcpToolCall' && typeof item.tool === 'string') return typeof item.server === 'string' ? `${item.server}.${item.tool}` : item.tool;
    return typeof item.type === 'string' ? item.type : 'a tool';
}

function turnError(turn: { status?: unknown; error?: { message?: unknown } | null } | undefined): string | null {
    if (!turn || turn.status === 'completed') return null;
    const message = turn.error && typeof turn.error.message === 'string' ? turn.error.message : '';
    return message || `Side question ended (${String(turn.status ?? 'unknown')})`;
}

export interface CodexSideQuestionInput extends SideQuestionInput {
    /** `resumeSessionId` is the main Codex thread id here (null before the thread exists). */
}

export async function runCodexSideQuestion(createClient: () => CodexSideClient, input: CodexSideQuestionInput): Promise<SideQuestionResult> {
    const client = createClient();
    const signal = input.signal;
    if (signal?.aborted) throw new Error('Side question cancelled');
    let threadId: string | null = null;
    let turnId: string | null = null;
    let streamed = '';
    const messages = new Map<string, string>();
    let toolAttempt: string | null = null;
    let settle!: (outcome: { error?: string }) => void;
    const done = new Promise<{ error?: string }>((resolve) => { settle = resolve; });
    const interrupt = () => {
        if (threadId && turnId) void client.interruptSideTurn(threadId, turnId).catch(() => {});
    };
    const off = client.onRawNotification((method, params) => {
        if (!threadId || params?.threadId !== threadId) return;
        // Notifications can beat the `turn/start` response.
        if (!turnId && typeof params.turnId === 'string') turnId = params.turnId;
        if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
            streamed += params.delta;
            input.onText?.(streamed);
        } else if (method === 'item/started' && params.item && !ANSWER_ITEMS.has(params.item.type)) {
            // Read-only sandbox + approval never already stop writes; a side
            // answer must not run anything at all (Claude parity: no tools).
            toolAttempt ??= toolName(params.item);
            interrupt();
        } else if (method === 'item/completed' && params.item?.type === 'agentMessage' && typeof params.item.text === 'string') {
            messages.set(params.item.id ?? String(messages.size), params.item.text);
        } else if (method === 'turn/completed') {
            settle({ error: toolAttempt ? undefined : turnError(params.turn) ?? undefined });
        }
    });
    const onAbort = () => { interrupt(); settle({ error: 'Side question cancelled' }); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        await client.connect();
        let hadContext = Boolean(input.resumeSessionId);
        try {
            ({ threadId } = await client.openSideThread({ sourceThreadId: input.resumeSessionId, cwd: input.cwd, model: input.model, developerInstructions: CODEX_SIDE_QUESTION_INSTRUCTIONS }));
        } catch (error) {
            // A thread whose rollout is not on disk yet cannot be forked: answer
            // without context, like the Claude path before its first turn.
            if (!input.resumeSessionId || signal?.aborted) throw error;
            hadContext = false;
            ({ threadId } = await client.openSideThread({ sourceThreadId: null, cwd: input.cwd, model: input.model, developerInstructions: CODEX_SIDE_QUESTION_INSTRUCTIONS }));
        }
        if (signal?.aborted) throw new Error('Side question cancelled');
        turnId = (await client.startSideTurn(threadId, buildSideQuestionPrompt(input.question, input.history, input.mainStatus))) ?? turnId;
        // A cancel or a tool attempt that arrived before the turn id was known.
        if (signal?.aborted || toolAttempt) interrupt();
        const outcome = await done;
        if (signal?.aborted) throw new Error('Side question cancelled');
        if (outcome.error) throw new Error(outcome.error);
        const final = [...messages.values()].filter((text) => text.trim()).join('\n\n') || streamed;
        const answer = toolAttempt ? [final.trim(), toolAttemptNotice(toolAttempt)].filter(Boolean).join('\n\n') : final;
        if (!answer.trim()) throw new Error('Side question ended without a result');
        input.onText?.(answer);
        return { answer, hadContext, mode: 'fork' };
    } finally {
        off();
        signal?.removeEventListener('abort', onAbort);
        // Stops the side app-server; the ephemeral thread dies with it.
        await client.disconnect().catch(() => {});
    }
}
