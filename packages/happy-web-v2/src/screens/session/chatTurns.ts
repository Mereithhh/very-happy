import type { Message, ToolCallMessage } from '@/sync/typesMessage';
import { askUserQuestionDisplayAnswer, type AskQuestion } from './askUserQuestion';
import { stripHarnessBlocks } from './harness';
import { presentServiceEvent } from './serviceEvent';
import { stripThinkingWrapper } from './thinking';

export type LeafRow =
    | {
        type: 'message';
        key: string;
        message: Message;
        showMeta: boolean;
        thinkingDurationMs?: number;
        /** B-355: the `file` events the user sent WITH this message. */
        attachments?: ToolCallMessage[];
    }
    | { type: 'toolgroup'; key: string; tools: ToolCallMessage[] };

export type ChatRow = LeafRow | {
    type: 'activity';
    key: string;
    messages: Message[];
    live: boolean;
    durationSeconds?: number;
};

/**
 * 把「紧邻在一条 user-text 之前的一串 `file` 事件」摘出来挂到那条消息上（B-355）。
 *
 * 附件是**用户这一轮输入的一部分**，但 reducer 把 `file` 事件归一化成了名为 `file` 的
 * tool-call（`sync/typesRaw.ts`），于是它在会话里长得像 agent 跑了个工具——一行带
 * chevron 的工具卡，浮在用户气泡上面。
 *
 * **必须在这里、在分流之前做**：`buildChatRows` 下面有三条分支，`file` 事件实测有三种
 * 落点（toolgroup 首段 / toolgroup 尾段 / 上一轮没有 final agent text 时**落进 activity
 * 折叠抽屉**）。只改 toolgroup 那一处的话，第三种落点里的附件会直接从视野里消失。
 *
 * **不许改走 `knownTools` 的 hidden 名单**那条捷径：`ChatList` 的 `isHiddenToolCall`
 * 会把它从 `chronological` 整个滤掉，连带 `agentLiveness.currentTurnMessages` 的切点和
 * 队列里的「已排队文件」标签一起坏。
 */
export function extractUserAttachments(messages: Message[]): {
    messages: Message[];
    attachments: Map<string, ToolCallMessage[]>;
} {
    const attachments = new Map<string, ToolCallMessage[]>();
    const isFileEvent = (m: Message | undefined) => m?.kind === 'tool-call' && m.tool.name === 'file';
    if (!messages.some(isFileEvent)) return { messages, attachments };

    const kept: Message[] = [];
    let i = 0;
    while (i < messages.length) {
        if (!isFileEvent(messages[i])) {
            kept.push(messages[i]);
            i += 1;
            continue;
        }
        let end = i;
        while (end < messages.length && isFileEvent(messages[end])) end += 1;
        const owner = messages[end];
        if (owner && owner.kind === 'user-text') {
            attachments.set(owner.id, messages.slice(i, end) as ToolCallMessage[]);
        } else {
            // orphan run (nothing sent with it) — leave it in the transcript so
            // the file is still visible somewhere
            kept.push(...messages.slice(i, end));
        }
        i = end;
    }
    return { messages: kept, attachments };
}

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
        if (message.kind === 'agent-text' && !message.isThinking && renderableAgentText(message)) return message.id;
    }
    return null;
}

function renderableAgentText(message: Extract<Message, { kind: 'agent-text' }>): boolean {
    const content = stripHarnessBlocks(message.text);
    return message.isThinking ? stripThinkingWrapper(content).length > 0 : content.trim().length > 0;
}

/** Keep the activity disclosure in lockstep with what its leaf views can render. */
export function isRenderableActivityMessage(message: Message): boolean {
    if (message.kind === 'agent-text') return renderableAgentText(message);
    if (message.kind !== 'agent-event') return true;
    if (message.event.type === 'ready') return false;
    if (message.event.type === 'message') {
        const presentation = presentServiceEvent(message.event.message);
        return presentation.kind !== 'hidden' && (presentation.kind !== 'subtle' || presentation.text.trim().length > 0);
    }
    return true;
}

/** Render leaf messages, optionally keeping consecutive tools in a compact group. */
export function buildLeafRows(
    messages: Message[],
    finalAgentId: string | null,
    groupConsecutiveTools = true,
    projectAskAnswers = true,
    attachments?: Map<string, ToolCallMessage[]>,
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
            ...(attachments?.has(message.id) ? { attachments: attachments.get(message.id) } : {}),
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
export function buildChatRows(rawMessages: Message[], sessionLive: boolean): ChatRow[] {
    // B-355: attachments belong to the user turn, so they leave the stream here —
    // BEFORE the leaf/activity split below, which has three different landing
    // places for them (see extractUserAttachments).
    const { messages, attachments: userAttachments } = extractUserAttachments(rawMessages);
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

        rows.push(...buildLeafRows([message], finalAgentId, true, true, userAttachments));
        const turnStart = i + 1;
        let turnEnd = turnStart;
        while (turnEnd < messages.length && messages[turnEnd].kind !== 'user-text') turnEnd++;
        const turnMessages = messages.slice(turnStart, turnEnd);
        const live = sessionLive && turnEnd === messages.length;

        if (live) {
            const activity = turnMessages.filter(isRenderableActivityMessage);
            if (activity.length > 0) {
                rows.push({
                    type: 'activity',
                    key: `activity-${message.id}`,
                    messages: activity,
                    live: true,
                });
                rows.push(...askAnswerRows(turnMessages));
            }
        } else {
            let finalIndex = -1;
            for (let j = turnMessages.length - 1; j >= 0; j--) {
                const candidate = turnMessages[j];
                if (candidate.kind === 'agent-text' && !candidate.isThinking && renderableAgentText(candidate)) {
                    finalIndex = j;
                    break;
                }
            }

            if (finalIndex < 0) {
                const activity = turnMessages.filter(isRenderableActivityMessage);
                if (activity.length > 0) {
                    rows.push({
                        type: 'activity',
                        key: `activity-${message.id}`,
                        messages: activity,
                        live: false,
                        durationSeconds: activityDurationSeconds(activity),
                    });
                    rows.push(...askAnswerRows(turnMessages));
                }
            } else {
                const activity = turnMessages
                    .slice(0, finalIndex)
                    .filter(isRenderableActivityMessage);
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
