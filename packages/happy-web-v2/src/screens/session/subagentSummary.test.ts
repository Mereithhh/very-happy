import { describe, expect, it } from 'vitest';
import { buildSubagentSummary, isSubagentToolName } from './subagentSummary';
import type { Message, ToolCallMessage } from '@/sync/typesMessage';

function childTool(id: string, seq: number, name: string, input: Record<string, unknown>, state: 'running' | 'completed' = 'completed'): Message {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: seq * 10,
        seq,
        tool: { name, state, input, createdAt: seq * 10, startedAt: null, completedAt: null, description: null, result: undefined },
        children: [],
    } as unknown as Message;
}

function card(input: Record<string, unknown>, children: Message[]): ToolCallMessage {
    return {
        kind: 'tool-call',
        id: 'card',
        localId: null,
        createdAt: 0,
        tool: { name: 'Agent', state: 'completed', input, createdAt: 0, startedAt: null, completedAt: null, description: null, result: undefined },
        children,
    } as unknown as ToolCallMessage;
}

describe('buildSubagentSummary (B-260)', () => {
    it('title priority is description ?? name ?? subagent_type; badge is subagent_type', () => {
        expect(buildSubagentSummary(card({ description: 'Review changes', name: 'rev', subagent_type: 'Explore' }, [])).title).toBe('Review changes');
        expect(buildSubagentSummary(card({ name: 'rev', subagent_type: 'Explore' }, [])).title).toBe('rev');
        expect(buildSubagentSummary(card({ subagent_type: 'Explore' }, [])).title).toBe('Explore');
        expect(buildSubagentSummary(card({}, [])).title).toBeNull();
        expect(buildSubagentSummary(card({ subagent_type: 'Explore' }, [])).subtype).toBe('Explore');
    });

    it('sorts child tools chronologically even when children arrived newest-first (cross-page prepend)', () => {
        const children = [
            childTool('c3', 30, 'Bash', { command: 'pnpm test' }),
            childTool('c1', 10, 'Read', { file_path: '/a/one.ts' }),
            childTool('c2', 20, 'Grep', { pattern: 'foo' }),
        ];
        const summary = buildSubagentSummary(card({}, children));
        expect(summary.toolCount).toBe(3);
        expect(summary.childTools.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
        expect(summary.recent[summary.recent.length - 1]).toBe('[Terminal] pnpm test');
    });

    it('recent keeps the last N one-liners and ignores non-tool children (text/thinking)', () => {
        const children = [
            childTool('c1', 1, 'Read', { file_path: '/a/one.ts' }),
            { kind: 'agent-text', id: 't1', localId: null, createdAt: 15, text: 'thinking…' } as unknown as Message,
            childTool('c2', 2, 'Read', { file_path: '/a/two.ts' }),
            childTool('c3', 3, 'Read', { file_path: '/a/three.ts' }),
            childTool('c4', 4, 'Read', { file_path: '/a/four.ts' }),
        ];
        const summary = buildSubagentSummary(card({}, children), 3);
        expect(summary.toolCount).toBe(4);
        expect(summary.recent).toEqual(['[Read] two.ts', '[Read] three.ts', '[Read] four.ts']);
    });

    it('isSubagentToolName covers Task and Agent only', () => {
        expect(isSubagentToolName('Task')).toBe(true);
        expect(isSubagentToolName('Agent')).toBe(true);
        expect(isSubagentToolName('Bash')).toBe(false);
    });
});
