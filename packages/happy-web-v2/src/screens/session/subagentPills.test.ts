import { describe, expect, it } from 'vitest';
import { collectSubagentCardIds, countSubagentCards, suppressSubagentPills } from './subagentPills';
import type { Message } from '@/sync/typesMessage';

function agentCard(id: string, sessionSubagent?: string): Message {
    return {
        kind: 'tool-call',
        id: `card-${id}`,
        localId: null,
        createdAt: 100,
        tool: {
            name: 'Agent',
            state: 'completed',
            input: sessionSubagent ? { prompt: 'x', sessionSubagent } : { prompt: 'x' },
            createdAt: 100,
            startedAt: null,
            completedAt: null,
            description: null,
            result: undefined,
        },
        children: [],
    } as unknown as Message;
}

function pill(id: string, status: 'running' | 'completed'): Message {
    return {
        kind: 'agent-event',
        id: `pill-${id}-${status}`,
        localId: null,
        createdAt: 200,
        event: { type: 'subagent', id, status },
    } as unknown as Message;
}

describe('suppressSubagentPills (B-260)', () => {
    it('drops start/stop pills whose id matches an Agent card, keeps others', () => {
        const messages = [agentCard('a', 'sub-1'), pill('sub-1', 'running'), pill('sub-1', 'completed'), pill('sub-2', 'running')];
        const result = suppressSubagentPills(messages);
        expect(result.map((m) => m.id)).toEqual(['card-a', 'pill-sub-2-running']);
    });

    it('is order-independent: a pill arriving before its card (DESC page) is still suppressed', () => {
        const messages = [pill('sub-1', 'completed'), agentCard('a', 'sub-1')];
        expect(suppressSubagentPills(messages).map((m) => m.id)).toEqual(['card-a']);
    });

    it('keeps every pill when no card carries sessionSubagent (Codex / old CLI)', () => {
        const messages = [agentCard('legacy'), pill('sub-1', 'running')];
        expect(suppressSubagentPills(messages)).toBe(messages);
        expect(collectSubagentCardIds(messages).size).toBe(0);
    });

    it('suppresses a cross-turn stop pill via the whole-conversation card set', () => {
        // The card lives in an earlier turn; the stop arrives turns later.
        const messages = [agentCard('a', 'sub-1'), { kind: 'user-text', id: 'u1', localId: null, createdAt: 150, text: 'next' } as unknown as Message, pill('sub-1', 'completed')];
        expect(suppressSubagentPills(messages).map((m) => m.id)).toEqual(['card-a', 'u1']);
    });
});

describe('countSubagentCards', () => {
    it('counts Task and Agent tool calls only', () => {
        const messages = [agentCard('a', 'sub-1'), agentCard('b'), pill('sub-1', 'running')];
        expect(countSubagentCards(messages)).toBe(2);
    });
});
