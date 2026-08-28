import type { Message, ToolCallMessage } from '@/sync/typesMessage';
import { askUserQuestionDisplayAnswer, type AskQuestion } from './askUserQuestion';
import { visibleToolCalls } from './toolVisibility';

export type ChatRow =
    | { type: 'message'; key: string; message: Message; showMeta: boolean; thinkingDurationMs?: number }
    | { type: 'toolgroup'; key: string; tools: ToolCallMessage[] };

/** Pure transcript projection, including display-only AskUserQuestion replies. */
export function buildChatRows(messages: Message[]): ChatRow[] {
    const rows: ChatRow[] = [];
    let lastAgentTextIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].kind === 'agent-text' && !(messages[i] as any).isThinking) {
            lastAgentTextIdx = i;
            break;
        }
    }

    let i = 0;
    while (i < messages.length) {
        const m = messages[i];
        if (m.kind === 'tool-call') {
            const tools: ToolCallMessage[] = [];
            while (i < messages.length && messages[i].kind === 'tool-call') {
                tools.push(messages[i] as ToolCallMessage);
                i++;
            }
            const visibleTools = visibleToolCalls(tools);
            if (visibleTools.length > 0) {
                rows.push({ type: 'toolgroup', key: `tg-${visibleTools[0].id}`, tools: visibleTools });
            }
            for (const toolMessage of tools) {
                if (toolMessage.tool.name !== 'AskUserQuestion' || toolMessage.tool.state !== 'completed') continue;
                const questions = Array.isArray(toolMessage.tool.input?.questions)
                    ? toolMessage.tool.input.questions as AskQuestion[]
                    : [];
                const answer = askUserQuestionDisplayAnswer(questions, toolMessage.tool.result);
                if (!answer) continue;
                rows.push({
                    type: 'message',
                    key: `${toolMessage.id}:answer`,
                    showMeta: false,
                    message: {
                        kind: 'user-text',
                        id: `${toolMessage.id}:answer`,
                        localId: null,
                        createdAt: toolMessage.tool.completedAt ?? toolMessage.createdAt,
                        text: answer,
                    },
                });
            }
            continue;
        }
        let thinkingDurationMs: number | undefined;
        if (m.kind === 'agent-text' && (m as any).isThinking) {
            const next = messages[i + 1];
            if (next && next.createdAt > m.createdAt) {
                thinkingDurationMs = next.createdAt - m.createdAt;
            }
        }
        rows.push({ type: 'message', key: m.id, message: m, showMeta: i === lastAgentTextIdx, thinkingDurationMs });
        i++;
    }
    return rows;
}
