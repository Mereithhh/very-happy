import { describe, expect, it } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import { buildChatRows } from './chatTurns';
import {
    activeRailIndex,
    adjacentPromptIndex,
    firstReplyLine,
    railItemsFromRows,
    railKeyStep,
    railScrollTarget,
    railTickPercent,
    shouldShowRail,
    truncateRailText,
} from './chatRail';

const user = (id: string, createdAt: number, text = id): Message => ({ kind: 'user-text', id, localId: null, createdAt, text });
const agent = (id: string, createdAt: number, text = id, isThinking = false): Message => ({ kind: 'agent-text', id, localId: null, createdAt, text, isThinking });
const tool = (id: string, createdAt: number): Message => ({
    kind: 'tool-call', id, localId: null, createdAt, children: [],
    tool: { name: 'Read', state: 'completed', input: {}, createdAt, startedAt: createdAt, completedAt: createdAt + 1, description: null },
} as Message);

describe('railItemsFromRows (B-579)', () => {
    it('lists the user prompts oldest-first with the first line of their answer', () => {
        const rows = buildChatRows([
            agent('preamble', 0, 'before any prompt'),
            user('u1', 1, 'first   question\nwith two lines'),
            agent('think', 2, 'pondering', true),
            tool('read', 3),
            agent('a1', 4, '## Summary\n\nThe answer body'),
            user('u2', 5, '/model opus'),
            user('u3', 6, '<task-notification><summary>job done</summary><status>completed</status></task-notification>'),
            agent('a3', 7, 'follow-up to the job'),
            user('u4', 8, 'third'),
        ], false);
        expect(railItemsFromRows(rows)).toEqual([
            { id: 'u1', text: 'first question with two lines', reply: 'Summary' },
            { id: 'u2', text: '/model opus', reply: '' },
            { id: 'u4', text: 'third', reply: '' },
        ]);
    });

    it('skips projected AskUserQuestion answers', () => {
        const ask: Message = {
            kind: 'tool-call', id: 'ask', localId: null, createdAt: 2, children: [],
            tool: {
                name: 'AskUserQuestion', state: 'completed', createdAt: 2, startedAt: 2, completedAt: 3, description: null,
                input: { questions: [{ question: 'Pick', options: [{ label: 'A' }] }] },
                result: 'User has answered your questions: "Pick"="A".',
            },
        } as Message;
        const rows = buildChatRows([user('u1', 1, 'go'), ask, agent('a', 4, 'ok')], false);
        expect(railItemsFromRows(rows).map((item) => item.id)).toEqual(['u1']);
    });

    it('cleans markdown off the reply line and truncates long text', () => {
        expect(firstReplyLine('\n\n> **Note**: careful\nmore')).toBe('Note: careful');
        expect(firstReplyLine('```ts\nconst a = 1\n```')).toBe('const a = 1');
        expect(firstReplyLine('- item one')).toBe('item one');
        const long = truncateRailText('x'.repeat(300));
        expect(long).toHaveLength(120);
        expect(long.endsWith('…')).toBe(true);
    });
});

describe('rail geometry', () => {
    const tops = [100, 900, 2000];
    it('places ticks by position in the conversation', () => {
        expect(railTickPercent(900, 3000)).toBe(30);
        expect(railTickPercent(5000, 3000)).toBe(100);
        expect(railTickPercent(10, 0)).toBe(0);
    });

    it('lights the prompt being read: the last one at the bottom, else the last above the fold', () => {
        expect(activeRailIndex(tops, { scrollTop: 2400, clientHeight: 600, scrollHeight: 3000 })).toBe(2);
        expect(activeRailIndex(tops, { scrollTop: 800, clientHeight: 800, scrollHeight: 3000 })).toBe(1);
        // a long answer to the first prompt keeps the first prompt lit
        expect(activeRailIndex(tops, { scrollTop: 500, clientHeight: 600, scrollHeight: 3000 })).toBe(0);
        expect(activeRailIndex(tops, { scrollTop: 0, clientHeight: 200, scrollHeight: 3000 })).toBe(-1);
        expect(activeRailIndex([], { scrollTop: 0, clientHeight: 200, scrollHeight: 3000 })).toBe(-1);
    });

    it('steps to the previous / next prompt relative to where a jump would land', () => {
        // sitting exactly on prompt 1 (as a jump leaves it)
        const onSecond = railScrollTarget(900);
        expect(adjacentPromptIndex(tops, onSecond, -1)).toBe(0);
        expect(adjacentPromptIndex(tops, onSecond, 1)).toBe(2);
        expect(adjacentPromptIndex(tops, 0, -1)).toBeNull();
        expect(adjacentPromptIndex(tops, 1990, 1)).toBeNull();
        expect(adjacentPromptIndex(tops, 1500, -1)).toBe(1);
    });

    it('maps rail keys and clamps at the ends', () => {
        expect(railKeyStep('ArrowDown', 0, 3)).toBe(1);
        expect(railKeyStep('ArrowDown', 2, 3)).toBe(2);
        expect(railKeyStep('ArrowUp', 0, 3)).toBe(0);
        expect(railKeyStep('Home', 2, 3)).toBe(0);
        expect(railKeyStep('End', 0, 3)).toBe(2);
        expect(railKeyStep('Enter', 0, 3)).toBeNull();
        expect(railKeyStep('ArrowDown', 0, 0)).toBeNull();
    });

    it('shows the rail only for a fine pointer, a wide enough gutter and two prompts', () => {
        expect(shouldShowRail({ finePointer: true, gutter: 116, count: 3 })).toBe(true);
        expect(shouldShowRail({ finePointer: false, gutter: 116, count: 3 })).toBe(false);
        expect(shouldShowRail({ finePointer: true, gutter: 20, count: 3 })).toBe(false);
        expect(shouldShowRail({ finePointer: true, gutter: 116, count: 1 })).toBe(false);
    });
});

describe('quantizeRailPercents', () => {
    it('keeps tick positions still while the transcript grows by a few pixels', async () => {
        const { quantizeRailPercents, sameNumbers } = await import('./chatRail');
        const before = quantizeRailPercents([100, 900, 2000], 3000);
        const growing = quantizeRailPercents([100, 900, 2000], 3006);
        expect(before).toEqual([3, 30, 67]);
        expect(sameNumbers(before, growing)).toBe(true);
        expect(sameNumbers(before, quantizeRailPercents([100, 900, 2000], 3300))).toBe(false);
    });
});
