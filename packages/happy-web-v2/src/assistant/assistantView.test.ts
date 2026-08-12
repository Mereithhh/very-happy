import { describe, it, expect } from 'vitest';
import { deriveAssistantExchange, collectNewAgentTexts, collectMessageIds } from './assistantView';
import type { Message } from '@/sync/typesMessage';

function user(id: string, text: string, seq: number): Message {
    return { kind: 'user-text', id, localId: null, createdAt: seq, seq, text };
}
function agent(id: string, text: string, seq: number, isThinking = false): Message {
    return { kind: 'agent-text', id, localId: null, createdAt: seq, seq, text, isThinking };
}
function tool(id: string, name: string, seq: number, state: 'running' | 'completed' | 'error'): Message {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: seq,
        seq,
        tool: { name, state, input: {}, createdAt: seq, startedAt: seq, completedAt: null, description: null },
        children: [],
    };
}

describe('deriveAssistantExchange', () => {
    it('extracts the newest user text, agent reply and tool call', () => {
        const messages: Message[] = [
            user('u1', 'old question', 1),
            agent('a1', 'old answer', 2),
            user('u2', 'new question', 3),
            tool('t1', 'Bash', 4, 'completed'),
            tool('t2', 'Read', 5, 'running'),
            agent('a2', 'new answer', 6),
        ];
        expect(deriveAssistantExchange(messages)).toEqual({
            userText: 'new question',
            assistantText: 'new answer',
            tool: { name: 'Read', state: 'running' },
        });
    });

    it('is independent of input array order (sorts via shared comparator)', () => {
        const messages: Message[] = [
            agent('a2', 'new answer', 6),
            user('u1', 'old question', 1),
            agent('a1', 'old answer', 2),
            user('u2', 'new question', 3),
        ];
        const out = deriveAssistantExchange(messages);
        expect(out.userText).toBe('new question');
        expect(out.assistantText).toBe('new answer');
    });

    it('prefers displayText for user messages and skips thinking blocks', () => {
        const messages: Message[] = [
            { ...user('u1', 'raw text', 1), displayText: 'shown text' } as Message,
            agent('a1', 'thinking...', 2, true),
            agent('a2', 'real reply', 3),
        ];
        const out = deriveAssistantExchange(messages);
        expect(out.userText).toBe('shown text');
        expect(out.assistantText).toBe('real reply');
    });

    it('returns nulls on an empty conversation', () => {
        expect(deriveAssistantExchange([])).toEqual({ userText: null, assistantText: null, tool: null });
    });
});

describe('collectNewAgentTexts', () => {
    it('returns only agent texts not in the baseline, oldest first', () => {
        const baselineMessages: Message[] = [user('u1', 'q', 1), agent('a1', 'old', 2)];
        const known = collectMessageIds(baselineMessages);
        const now: Message[] = [
            ...baselineMessages,
            agent('a3', 'second new', 5),
            agent('a2', 'first new', 4),
        ];
        const fresh = collectNewAgentTexts(now, known);
        expect(fresh.map((m) => m.id)).toEqual(['a2', 'a3']);
    });

    it('never surfaces thinking or empty texts', () => {
        const now: Message[] = [
            agent('a1', '  ', 1),
            agent('a2', 'think', 2, true),
            agent('a3', 'speak me', 3),
        ];
        const fresh = collectNewAgentTexts(now, new Set());
        expect(fresh.map((m) => m.id)).toEqual(['a3']);
    });

    it('user and tool messages are never TTS candidates', () => {
        const now: Message[] = [user('u1', 'q', 1), tool('t1', 'Bash', 2, 'running')];
        expect(collectNewAgentTexts(now, new Set())).toEqual([]);
    });
});
