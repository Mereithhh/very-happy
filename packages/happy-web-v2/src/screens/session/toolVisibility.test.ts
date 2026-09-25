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
    it('hides Claude deferred-tool lookup', () => {
        expect(isHiddenToolName('ToolSearch')).toBe(true);
    });

    // B-499: change_title is a visible "Title changed · …" row for the runners
    // that do not turn it into an event (Codex / pi / Gemini); the Claude path
    // never reaches the tool list (messageToEvent), so nothing doubles up.
    it('keeps change_title visible in every name shape', () => {
        expect(isHiddenToolName('mcp__happy__change_title')).toBe(false);
        expect(isHiddenToolName('change_title')).toBe(false);
    });

    it('keeps unknown MCP tools visible', () => {
        expect(isHiddenToolName('mcp__todo__list_tasks')).toBe(false);
    });

    it('checks hidden-ness on the pi-normalised identity (B-353), not on `other`', () => {
        const piTitle = { ...tool('p', 'other').tool, input: { piTool: 'change_title', rawInput: { title: 'x' } } };
        expect(isHiddenToolCall(piTitle)).toBe(false);
        expect(isHiddenToolCall({ ...tool('q', 'other').tool, input: { piTool: 'session_send', rawInput: {} } })).toBe(false);
        expect(visibleToolCalls([{ ...tool('p', 'other'), tool: piTitle }, tool('2', 'Read')]).map((m) => m.id)).toEqual(['p', '2']);
    });

    it('removes hidden calls without swallowing adjacent visible calls', () => {
        const calls = [tool('1', 'Read'), tool('2', 'ToolSearch'), tool('3', 'Write')];
        expect(visibleToolCalls(calls).map((message) => message.tool.name)).toEqual(['Read', 'Write']);
    });
});
