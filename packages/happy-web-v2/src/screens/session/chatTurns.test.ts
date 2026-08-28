import { describe, expect, it } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import { buildChatRows, buildLeafRows } from './chatTurns';

const user = (id: string, createdAt: number): Message => ({
    kind: 'user-text', id, localId: null, createdAt, text: id,
});
const agent = (id: string, createdAt: number, isThinking = false): Message => ({
    kind: 'agent-text', id, localId: null, createdAt, text: id, isThinking,
});
const finalAgent = (id: string, createdAt: number, totalDurationMs: number): Message => ({
    kind: 'agent-text', id, localId: null, createdAt, text: id, totalDurationMs,
});
const tool = (id: string, createdAt: number, state: 'running' | 'completed' = 'completed'): Message => ({
    kind: 'tool-call', id, localId: null, createdAt, children: [],
    tool: {
        name: id,
        state,
        input: {},
        createdAt,
        startedAt: createdAt,
        completedAt: state === 'completed' ? createdAt + 10 : null,
        description: null,
    },
});

describe('buildChatRows', () => {
    it('keeps the live turn detailed inside one activity row', () => {
        const rows = buildChatRows([
            user('u1', 1),
            agent('thinking', 2, true),
            agent('progress', 3),
            tool('read', 4, 'running'),
        ], true);

        expect(rows.map((row) => row.type)).toEqual(['message', 'activity']);
        expect(rows[1]).toMatchObject({
            type: 'activity',
            key: 'activity-u1',
            live: true,
            messages: [{ id: 'thinking' }, { id: 'progress' }, { id: 'read' }],
        });
    });

    it('collapses completed intermediate work but leaves the final answer visible', () => {
        const rows = buildChatRows([
            user('u1', 1),
            agent('thinking', 2, true),
            agent('progress', 3),
            tool('read', 4),
            agent('final', 5),
        ], false);

        expect(rows.map((row) => row.type)).toEqual(['message', 'activity', 'message']);
        expect(rows[1]).toMatchObject({
            type: 'activity',
            live: false,
            messages: [{ id: 'thinking' }, { id: 'progress' }, { id: 'read' }],
        });
        expect(rows[2]).toMatchObject({ type: 'message', message: { id: 'final' }, showMeta: true });
    });

    it('does not create an empty activity group for a direct answer', () => {
        const rows = buildChatRows([user('u1', 1), agent('final', 2)], false);
        expect(rows.map((row) => row.type)).toEqual(['message', 'message']);
    });

    it('uses a stable turn key when live work becomes completed history', () => {
        const live = buildChatRows([user('u1', 1), agent('thinking', 2, true)], true);
        const done = buildChatRows([user('u1', 1), agent('thinking', 2, true), agent('final', 3)], false);
        expect(live[1]).toMatchObject({ key: 'activity-u1' });
        expect(done[1]).toMatchObject({ key: 'activity-u1' });
    });

    it('uses the SDK turn duration for the completed activity header', () => {
        const rows = buildChatRows([
            user('u1', 1_000),
            agent('thinking', 2_000, true),
            tool('read', 3_000),
            finalAgent('final', 5_000, 99_400),
        ], false);

        expect(rows[1]).toMatchObject({ type: 'activity', durationSeconds: 99 });
    });

    it('falls back to the whole turn span when SDK duration is absent', () => {
        const rows = buildChatRows([
            user('u1', 1_000),
            agent('thinking', 2_000, true),
            agent('final', 7_000),
        ], false);

        expect(rows[1]).toMatchObject({ type: 'activity', durationSeconds: 5 });
    });

    it('can expose consecutive tools as independent disclosure rows', () => {
        const rows = buildLeafRows([tool('read', 1), tool('shell', 2, 'running')], null, false);
        expect(rows).toMatchObject([
            { type: 'toolgroup', tools: [{ id: 'read' }] },
            { type: 'toolgroup', tools: [{ id: 'shell' }] },
        ]);
    });

    it('keeps an AskUserQuestion reply visible outside collapsed turn activity', () => {
        const ask = tool('ask', 3_000) as Extract<Message, { kind: 'tool-call' }>;
        ask.tool.name = 'AskUserQuestion';
        ask.tool.input = {
            questions: [{ question: 'Library?', header: 'Library', options: [{ label: 'Luxon' }] }],
        };
        ask.tool.result = { answers: { 'Library?': 'Luxon' } };

        const rows = buildChatRows([
            user('u1', 1_000),
            agent('thinking', 2_000, true),
            ask,
            agent('final', 5_000),
        ], false);

        expect(rows.map((row) => row.key)).toEqual(['u1', 'activity-u1', 'ask:answer', 'final']);
        expect(rows[2]).toMatchObject({
            type: 'message',
            message: { kind: 'user-text', text: 'Luxon' },
        });
    });
});
