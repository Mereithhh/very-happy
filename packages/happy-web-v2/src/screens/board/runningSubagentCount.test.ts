// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Message } from '@/sync/typesMessage';
import { compareMessagesNewestFirst } from '@/sync/messageOrder';
import { sessionExecution } from '@/sync/agentStatus';
import { runningBackgroundCounts } from './useBoardItems';

/**
 * B-561: the board/sidebar fed storage's NEWEST-FIRST array straight into
 * `currentTurnMessages` (which requires oldest-first, rule 15). Scanning from
 * the array's tail found the session's FIRST user prompt and returned what
 * came before it — so a sub-agent running after the main turn ended counted 0
 * and the row read idle / 等我看 instead of running.
 */
let seq = 0;
function msg(kind: string, extra: Record<string, unknown>): Message {
    seq += 1;
    return { id: `m${seq}`, localId: null, seq, createdAt: seq * 1000, kind, ...extra } as unknown as Message;
}
const user = (text: string) => msg('user-text', { text });
const reply = (text: string) => msg('agent-text', { text, isThinking: false });
function agentCard(status: 'running' | 'completed'): Message {
    return msg('tool-call', {
        tool: { name: 'Agent', state: 'completed', input: { prompt: 'x' }, createdAt: 0, startedAt: null, completedAt: null, description: null, result: 'Async agent launched' },
        children: [],
        subagent: { status },
    });
}

/** Exactly how storage holds a session's messages. */
function storeState(sessions: Record<string, Message[]>) {
    const sessionMessages = Object.fromEntries(Object.entries(sessions).map(([id, chronological]) =>
        [id, { messages: [...chronological].sort(compareMessagesNewestFirst) }]));
    return { sessionMessages } as unknown as Parameters<typeof runningBackgroundCounts>[0];
}

describe('board running sub-agent count (B-561)', () => {
    it('counts a sub-agent still running after the main turn ended', () => {
        const counts = runningBackgroundCounts(storeState({
            s1: [user('earlier'), reply('done'), user('spawn two'), agentCard('running'), agentCard('running'), reply('launched, waiting')],
        }));
        expect(counts).toEqual({ s1: 2 });
        // …and with the turn over (thinking false) and a turn-end LLM verdict,
        // the row is running — not 等我看 (B-538's ordering, now actually fed).
        expect(sessionExecution({ online: true, active: true, fresh: true, thinking: false, needsInput: false,
            llmAttention: true, runningSubagents: counts.s1 })).toBe('running');
    });

    it('a finished sub-agent does not linger as running', () => {
        const counts = runningBackgroundCounts(storeState({
            s1: [user('spawn'), agentCard('completed'), reply('all done')],
        }));
        expect(counts).toEqual({});
        expect(sessionExecution({ online: true, active: true, fresh: true, thinking: false, needsInput: false,
            llmAttention: true, runningSubagents: counts.s1 ?? 0 })).toBe('input');
    });

    it('a stale running card from an earlier turn does not vote once the user spoke again', () => {
        const counts = runningBackgroundCounts(storeState({
            s1: [user('spawn'), agentCard('running'), reply('launched'), user('next question'), reply('answer')],
        }));
        expect(counts).toEqual({});
    });

    it('ChatList cuts the turn from the same shared transcript view as the board', () => {
        const source = readFileSync(resolve(import.meta.dirname, '../session/ChatList.tsx'), 'utf8');
        expect(source).toContain('const chronological = useMemo(() => transcriptChronological(messages), [messages]);');
    });
});
