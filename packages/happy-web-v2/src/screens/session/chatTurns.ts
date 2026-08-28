import type { Message, ToolCallMessage } from '@/sync/typesMessage';
import { askUserQuestionDisplayAnswer, type AskQuestion } from './askUserQuestion';

export type LeafRow =
    | { type: 'message'; key: string; message: Message; showMeta: boolean; thinkingDurationMs?: number }
    | { type: 'toolgroup'; key: string; tools: ToolCallMessage[] };

export type ChatRow = LeafRow | {
    type: 'activity';
    key: string;
    messages: Message[];
    live: boolean;
    durationSeconds?: number;
};

export function activityDurationSeconds(messages: Message[]): number {
    if (messages.length === 0) return 0;
    const start = Math.min(...messages.map((message) => message.createdAt));
    const end = Math.max(...messages.map((message) => {
        if (message.kind === 'tool-call') {
            return message.tool.completedAt ?? message.createdAt;
        }
        return message.createdAt;
    }));
    return Math.max(0, Math.round((end - start) / 1000));
}

function askAnswerRows(messages: Message[]): LeafRow[] {
    return messages.flatMap((message): LeafRow[] => {
        if (message.kind !== 'tool-call' || message.tool.name !== 'AskUserQuestion' || message.tool.state !== 'completed') {
            return [];
        }
        const questions = Array.isArray(message.tool.input?.questions)
            ? message.tool.input.questions as AskQuestion[]
            : [];
        const answer = askUserQuestionDisplayAnswer(questions, message.tool.result);
        if (!answer) return [];
        return [{
            type: 'message',
            key: `${message.id}:answer`,
            showMeta: false,
            message: {
                kind: 'user-text',
                id: `${message.id}:answer`,
                localId: null,
                createdAt: message.tool.completedAt ?? message.createdAt,
                text: answer,
            },
        }];
    });
}

function lastFinalAgentId(messages: Message[]): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.kind === 'agent-text' && !message.isThinking) return message.id;
    }
    return null;
}

/** Render leaf messages, optionally keeping consecutive tools in a compact group. */
export function buildLeafRows(
    messages: Message[],
    finalAgentId: string | null,
    groupConsecutiveTools = true,
    projectAskAnswers = true,
): LeafRow[] {
    const rows: LeafRow[] = [];
    let i = 0;
    while (i < messages.length) {
        const message = messages[i];
        if (message.kind === 'tool-call') {
            const tools: ToolCallMessage[] = [];
            while (
                i < messages.length &&
                messages[i].kind === 'tool-call' &&
                (groupConsecutiveTools || tools.length === 0)
            ) {
                tools.push(messages[i] as ToolCallMessage);
                i++;
            }
            rows.push({ type: 'toolgroup', key: `tg-${tools[0].id}`, tools });
            if (projectAskAnswers) rows.push(...askAnswerRows(tools));
            continue;
        }

        let thinkingDurationMs: number | undefined;
        if (message.kind === 'agent-text' && message.isThinking) {
            const next = messages[i + 1];
            if (next && next.createdAt > message.createdAt) {
                thinkingDurationMs = next.createdAt - message.createdAt;
            }
        }
        rows.push({
            type: 'message',
            key: message.id,
            message,
            showMeta: message.id === finalAgentId,
            thinkingDurationMs,
        });
        i++;
    }
    return rows;
}

/**
 * Group each user turn's intermediate agent work into one activity row.
 *
 * While the newest turn is live, every emitted block remains inside the open
 * activity row. Once the turn finishes, its final non-thinking agent message
 * moves out as the visible answer and the preceding work becomes collapsible.
 * Messages before the first user prompt stay as ordinary transcript rows.
 */
export function buildChatRows(messages: Message[], sessionLive: boolean): ChatRow[] {
    const rows: ChatRow[] = [];
    const finalAgentId = lastFinalAgentId(messages);
    let i = 0;

    while (i < messages.length) {
        const message = messages[i];
        if (message.kind !== 'user-text') {
            let end = i + 1;
            while (end < messages.length && messages[end].kind !== 'user-text') end++;
            rows.push(...buildLeafRows(messages.slice(i, end), finalAgentId));
            i = end;
            continue;
        }

        rows.push(...buildLeafRows([message], finalAgentId));
        const turnStart = i + 1;
        let turnEnd = turnStart;
        while (turnEnd < messages.length && messages[turnEnd].kind !== 'user-text') turnEnd++;
        const turnMessages = messages.slice(turnStart, turnEnd);
        const live = sessionLive && turnEnd === messages.length;

        if (live) {
            if (turnMessages.length > 0) {
                rows.push({
                    type: 'activity',
                    key: `activity-${message.id}`,
                    messages: turnMessages,
                    live: true,
                });
                rows.push(...askAnswerRows(turnMessages));
            }
        } else {
            let finalIndex = -1;
            for (let j = turnMessages.length - 1; j >= 0; j--) {
                const candidate = turnMessages[j];
                if (candidate.kind === 'agent-text' && !candidate.isThinking) {
                    finalIndex = j;
                    break;
                }
            }

            if (finalIndex < 0) {
                if (turnMessages.length > 0) {
                    rows.push({
                        type: 'activity',
                        key: `activity-${message.id}`,
                        messages: turnMessages,
                        live: false,
                        durationSeconds: activityDurationSeconds(turnMessages),
                    });
                    rows.push(...askAnswerRows(turnMessages));
                }
            } else {
                const activity = turnMessages.slice(0, finalIndex);
                if (activity.length > 0) {
                    const finalMessage = turnMessages[finalIndex];
                    const durationSeconds = finalMessage.kind === 'agent-text' && finalMessage.totalDurationMs != null
                        ? Math.max(0, Math.round(finalMessage.totalDurationMs / 1000))
                        : activityDurationSeconds([...activity, finalMessage]);
                    rows.push({
                        type: 'activity',
                        key: `activity-${message.id}`,
                        messages: activity,
                        live: false,
                        durationSeconds,
                    });
                    rows.push(...askAnswerRows(activity));
                }
                rows.push(...buildLeafRows(turnMessages.slice(finalIndex), finalAgentId));
            }
        }
        i = turnEnd;
    }

    return rows;
}
