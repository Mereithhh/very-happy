import { describe, it, expect } from 'vitest';
import { deriveAssistantExchange, collectNewAgentTexts, collectMessageIds, derivePendingPermission, deriveTranscript } from './assistantView';
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

describe('derivePendingPermission', () => {
    it('returns null when agentState is absent or has no requests', () => {
        expect(derivePendingPermission(null)).toBeNull();
        expect(derivePendingPermission(undefined)).toBeNull();
        expect(derivePendingPermission({})).toBeNull();
        expect(derivePendingPermission({ requests: null })).toBeNull();
        expect(derivePendingPermission({ requests: {} })).toBeNull();
    });

    it('returns the single pending request', () => {
        const res = derivePendingPermission({
            requests: { r1: { tool: 'Bash', arguments: { command: 'rm -rf x' }, createdAt: 10 } },
        });
        expect(res).toEqual({ id: 'r1', tool: 'Bash', count: 1 });
    });

    it('picks the newest by createdAt and counts all pending', () => {
        const res = derivePendingPermission({
            requests: {
                r1: { tool: 'Bash', arguments: {}, createdAt: 10 },
                r2: { tool: 'Write', arguments: {}, createdAt: 30 },
                r3: { tool: 'Edit', arguments: {}, createdAt: 20 },
            },
        });
        expect(res).toEqual({ id: 'r2', tool: 'Write', count: 3 });
    });

    it('treats a missing createdAt as oldest', () => {
        const res = derivePendingPermission({
            requests: {
                r1: { tool: 'Bash', arguments: {}, createdAt: null },
                r2: { tool: 'Write', arguments: {}, createdAt: 5 },
            },
        });
        expect(res).toEqual({ id: 'r2', tool: 'Write', count: 2 });
    });

    it('ignores malformed entries without a tool name', () => {
        const res = derivePendingPermission({
            requests: {
                r1: { tool: undefined as unknown as string, arguments: {}, createdAt: 99 },
                r2: { tool: 'Bash', arguments: {}, createdAt: 1 },
            },
        });
        expect(res).toEqual({ id: 'r2', tool: 'Bash', count: 1 });
    });
});

describe('deriveTranscript (B-059)', () => {
    it('returns entries oldest-first, dropping thinking blocks and empty texts', () => {
        const messages: Message[] = [
            agent('a2', 'second answer', 4),
            user('u1', 'question', 1),
            agent('think', 'pondering…', 2, true),
            tool('t1', 'Bash', 3, 'completed'),
            agent('empty', '   ', 5),
        ];
        expect(deriveTranscript(messages)).toEqual([
            { id: 'u1', role: 'user', text: 'question' },
            { id: 't1', role: 'tool', text: 'Bash · completed' },
            { id: 'a2', role: 'assistant', text: 'second answer' },
        ]);
    });

    it('is empty for no messages', () => {
        expect(deriveTranscript([])).toEqual([]);
    });
});
