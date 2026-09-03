import { describe, expect, it, vi } from 'vitest';
import type { ToolCallMessage } from '@/sync/typesMessage';
import { isHiddenToolCall, isHiddenToolName, visibleToolCalls } from './toolVisibility';

vi.mock('@/text', () => ({ t: (key: string) => key }));

function tool(id: string, name: string): ToolCallMessage {
    return {
        kind: 'tool-call',
        id,
        localId: id,
        createdAt: 1,
        seq: 1,
        tool: { name, state: 'completed', input: {} },
        children: [],
    } as unknown as ToolCallMessage;
}

describe('tool visibility', () => {
    it('hides Claude deferred-tool lookup and the title MCP tool', () => {
        expect(isHiddenToolName('ToolSearch')).toBe(true);
        expect(isHiddenToolName('mcp__happy__change_title')).toBe(true);
    });

    it('keeps unknown MCP tools visible', () => {
        expect(isHiddenToolName('mcp__todo__list_tasks')).toBe(false);
    });

    it('hides a pi change_title that arrives as other + piTool (B-353)', () => {
        const piTitle = { ...tool('p', 'other').tool, input: { piTool: 'change_title', rawInput: { title: 'x' } } };
        expect(isHiddenToolCall(piTitle)).toBe(true);
        expect(isHiddenToolCall({ ...tool('q', 'other').tool, input: { piTool: 'session_send', rawInput: {} } })).toBe(false);
        expect(visibleToolCalls([{ ...tool('p', 'other'), tool: piTitle }, tool('2', 'Read')]).map((m) => m.id)).toEqual(['2']);
    });

    it('removes hidden calls without swallowing adjacent visible calls', () => {
        const calls = [tool('1', 'Read'), tool('2', 'ToolSearch'), tool('3', 'Write')];
        expect(visibleToolCalls(calls).map((message) => message.tool.name)).toEqual(['Read', 'Write']);
    });
});
