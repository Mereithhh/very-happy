import type { Thread, ThreadItem, ThreadTurn } from './codexAppServerTypes';

export type CodexRewindPoint = {
    itemId: string;
    text: string;
    timestamp: number;
    hasAttachments?: boolean;
};

export type CodexForkResult = {
    type: 'success';
    newCodexThreadId: string;
};

type CodexForkClient = {
    forkThread: (opts: {
        threadId: string;
        cwd?: string;
        model?: string;
        approvalPolicy?: any;
        sandbox?: any;
        mcpServers?: Record<string, unknown>;
        lastTurnId?: string;
    }) => Promise<{ threadId: string; thread: Thread }>;
    rollbackThread: (opts: { threadId: string; numTurns: number }) => Promise<{ thread: Thread }>;
    injectItems: (opts: { threadId: string; items: unknown[] }) => Promise<unknown>;
};

export class CodexForkRewindPointNotFoundError extends Error {
    constructor(public readonly itemId: string, public readonly threadId: string) {
        super(`Codex rewind point ${itemId} not found in thread ${threadId}`);
        this.name = 'CodexForkRewindPointNotFoundError';
    }
}

function hasUserAttachments(item: ThreadItem): boolean {
    const content = (item as { content?: unknown }).content;
    return Array.isArray(content) && content.some((part) => !part || typeof part !== 'object'
        || part.type !== 'text' || (typeof part.text === 'string' && part.text.includes('<attached_files>')));
}

function rejectAttachedTarget(thread: Thread, itemId: string): void {
    const item = thread.turns?.flatMap((turn) => turn.items ?? []).find((item) => item.id === itemId);
    if (item && hasUserAttachments(item)) throw new Error('Cannot edit and rerun a message with attachments');
}

function textFromUserItem(item: ThreadItem): string | null {
    if (item.type !== 'userMessage') {
        return null;
    }
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) {
        return null;
    }
    const textParts = content
        .filter((part): part is { type: 'text'; text: string } => (
            Boolean(part)
            && typeof part === 'object'
            && (part as { type?: unknown }).type === 'text'
            && typeof (part as { text?: unknown }).text === 'string'
        ))
        .map((part) => part.text)
        .join('\n')
        .trim();
    return textParts.length > 0 ? textParts : null;
}

function timestampFromTurn(turn: ThreadTurn): number {
    const seconds = turn.startedAt ?? turn.completedAt;
    return typeof seconds === 'number' && Number.isFinite(seconds)
        ? seconds * 1000
        : Date.now();
}

export function listCodexRewindPoints(thread: Pick<Thread, 'turns'>): CodexRewindPoint[] {
    const points: CodexRewindPoint[] = [];
    for (const turn of thread.turns ?? []) {
        for (const item of turn.items ?? []) {
            const text = textFromUserItem(item);
            if (!text) {
                continue;
            }
            points.push({
                itemId: item.id,
                text,
                ...(hasUserAttachments(item) ? { hasAttachments: true } : {}),
                timestamp: timestampFromTurn(turn),
            });
        }
    }
    return points;
}

function findCutTurn(thread: Thread, itemId: string): { index: number; text: string } | null {
    const turns = thread.turns ?? [];
    for (let index = 0; index < turns.length; index++) {
        const turn = turns[index];
        const item = (turn.items ?? []).find((candidate) => candidate.id === itemId);
        if (!item) {
            continue;
        }
        const text = textFromUserItem(item);
        if (text) {
            return { index, text };
        }
    }
    return null;
}

export async function forkCodexThread(
    client: CodexForkClient,
    opts: {
        threadId: string;
        cwd?: string;
        cutAfterItemId?: string;
        model?: string;
        approvalPolicy?: any;
        sandbox?: any;
        mcpServers?: Record<string, unknown>;
    },
): Promise<CodexForkResult> {
    const forked = await client.forkThread({
        threadId: opts.threadId,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.approvalPolicy ? { approvalPolicy: opts.approvalPolicy } : {}),
        ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
        ...(opts.mcpServers ? { mcpServers: opts.mcpServers } : {}),
    });

    if (opts.cutAfterItemId) {
        const cutTurn = findCutTurn(forked.thread, opts.cutAfterItemId);
        if (!cutTurn) {
            throw new CodexForkRewindPointNotFoundError(opts.cutAfterItemId, opts.threadId);
        }
        const turns = forked.thread.turns ?? [];
        const turnsToDrop = turns.length - cutTurn.index;
        if (turnsToDrop > 0) {
            await client.rollbackThread({
                threadId: forked.threadId,
                numTurns: turnsToDrop,
            });
        }
        await client.injectItems({
            threadId: forked.threadId,
            items: [{
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: cutTurn.text }],
            }],
        });
    }

    return {
        type: 'success',
        newCodexThreadId: forked.threadId,
    };
}

function firstItemId(turn: ThreadTurn): string | undefined {
    return turn.items?.[0]?.id;
}

/** Fork and remove the selected turn without replaying its original prompt. */
export async function forkCodexBeforeUserMessage(
    client: CodexForkClient & { readThread: (opts: { threadId: string; includeTurns: boolean }) => Promise<{ thread: Thread }> },
    opts: { threadId: string; cwd: string; cutBeforeItemId: string },
): Promise<CodexForkResult | { type: 'success'; startFresh: true }> {
    const { thread: source } = await client.readThread({ threadId: opts.threadId, includeTurns: true });
    rejectAttachedTarget(source, opts.cutBeforeItemId);
    const sourceCut = findCutTurn(source, opts.cutBeforeItemId);
    if (!sourceCut) throw new CodexForkRewindPointNotFoundError(opts.cutBeforeItemId, opts.threadId);
    if ((source.turns?.[sourceCut.index].items ?? []).findIndex((item) => item.id === opts.cutBeforeItemId) !== 0) {
        throw new Error('Cannot safely rewind a user message inside an existing turn');
    }
    if (sourceCut.index === 0) return { type: 'success', startFresh: true };
    return forkThroughTurns(client, opts, (source.turns ?? []).slice(0, sourceCut.index));
}

/**
 * B-851: fork THROUGH the last of `kept` (`lastTurnId`). Codex 0.154+ forks
 * into a paginated thread that refuses the deprecated `thread/rollback`. An
 * older Codex ignores the field and copies everything; only then is the copy
 * cut back the old way. Either way the result is read back and checked turn
 * by turn (by each turn's first item — item ids survive a fork).
 */
async function forkThroughTurns(
    client: CodexForkClient & { readThread: (opts: { threadId: string; includeTurns: boolean }) => Promise<{ thread: Thread }> },
    opts: { threadId: string; cwd: string },
    kept: readonly ThreadTurn[],
): Promise<CodexForkResult> {
    const expected = kept.map(firstItemId);
    const forked = await client.forkThread({ threadId: opts.threadId, cwd: opts.cwd, lastTurnId: kept[kept.length - 1].id });
    if (forked.threadId === opts.threadId) throw new Error('Codex did not create an independent fork');
    let { thread } = await client.readThread({ threadId: forked.threadId, includeTurns: true });
    const extra = (thread.turns ?? []).length - expected.length;
    if (extra > 0) ({ thread } = await client.rollbackThread({ threadId: forked.threadId, numTurns: extra }));
    const remaining = (thread.turns ?? []).map(firstItemId);
    if (remaining.length !== expected.length || remaining.some((id, index) => id !== expected[index])) {
        throw new Error('Codex rollback did not preserve the expected history');
    }
    return { type: 'success', newCodexThreadId: forked.threadId };
}

/**
 * B-860: a turn the source's own app-server is still running. Another
 * app-server reads it from the rollout as `interrupted` (it has no
 * completion yet); a running Codex refuses to fork through it. Only asked
 * while the session is known to be running.
 */
function isUnfinishedTurn(turn: ThreadTurn | undefined): boolean {
    return turn?.status === 'inProgress' || turn?.status === 'interrupted';
}

/**
 * B-860: fork a RUNNING thread — every completed turn, not the one in
 * progress (its prompts come back as `excludedPrompts`). Verified on Codex
 * 0.154 from a second app-server while the source turn runs: `thread/fork`
 * with `lastTurnId` of the previous turn succeeds and the source turn
 * finishes untouched. `startFresh` = the running turn is the first one.
 */
export async function forkCodexCompletedTurns(
    client: CodexForkClient & { readThread: (opts: { threadId: string; includeTurns: boolean }) => Promise<{ thread: Thread }> },
    opts: { threadId: string; cwd: string },
): Promise<(CodexForkResult | { type: 'success'; startFresh: true }) & { excludedPrompts: string[] }> {
    const { thread: source } = await client.readThread({ threadId: opts.threadId, includeTurns: true });
    const turns = source.turns ?? [];
    const last = turns[turns.length - 1];
    if (!isUnfinishedTurn(last)) {
        return { ...(await forkCodexThread(client, opts)), excludedPrompts: [] };
    }
    const excludedPrompts = (last.items ?? []).flatMap((item) => {
        const text = textFromUserItem(item);
        return text ? [text] : [];
    });
    const kept = turns.slice(0, -1);
    if (kept.length === 0) return { type: 'success', startFresh: true, excludedPrompts };
    return { ...(await forkThroughTurns(client, opts, kept)), excludedPrompts };
}
