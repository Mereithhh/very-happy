import { describe, expect, it, vi } from 'vitest';
import type { Message, ToolCallMessage } from '@/sync/typesMessage';
import { buildChatRows } from './chatTurns';

vi.mock('@/text', () => ({ t: (key: string) => key }));

function askTool(result: unknown, state: ToolCallMessage['tool']['state'] = 'completed'): ToolCallMessage {
    return {
        kind: 'tool-call',
        id: 'ask-1',
        localId: null,
        createdAt: 100,
        tool: {
            name: 'AskUserQuestion',
            state,
            input: {
                questions: [
                    { question: 'Library?', header: 'Library', options: [{ label: 'date-fns' }] },
                ],
            },
            createdAt: 100,
            startedAt: 100,
            completedAt: state === 'completed' ? 200 : null,
            description: null,
            result,
        },
        children: [],
    };
}

/** 原来引用的是 `chatRows.ts`——生产代码从来没用过那个文件（ChatList 走 chatTurns），
 *  于是这套断言一直在守一份死代码。B-355 顺手迁到真正的行构造器上并删掉死文件。 */
describe('AskUserQuestion transcript rows', () => {
    it('places a display-only user reply immediately after the completed tool call', () => {
        const rows = buildChatRows([askTool(
            'Your questions have been answered: "Library?"="date-fns". You can now continue.',
        )], false);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ type: 'toolgroup' });
        expect(rows[1]).toMatchObject({
            type: 'message',
            key: 'ask-1:answer',
            message: { kind: 'user-text', text: 'date-fns', localId: null, createdAt: 200 },
        });
    });

    it('does not invent a reply before completion or when the SDK result has no answers', () => {
        expect(buildChatRows([askTool(undefined, 'running')], false)).toHaveLength(1);
        expect(buildChatRows([askTool({})], false)).toHaveLength(1);
    });

    it('keeps the projected reply before the following assistant message', () => {
        const assistant: Message = {
            kind: 'agent-text',
            id: 'assistant-1',
            localId: null,
            createdAt: 300,
            text: 'Continuing with date-fns.',
        };
        const rows = buildChatRows([askTool({ answers: { 'Library?': 'date-fns' } }), assistant], false);
        expect(rows.map((row) => row.key)).toEqual(['tg-ask-1', 'ask-1:answer', 'assistant-1']);
    });
});
