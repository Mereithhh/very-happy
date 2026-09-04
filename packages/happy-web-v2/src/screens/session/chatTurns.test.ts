import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import { buildChatRows, buildLeafRows, extractUserAttachments } from './chatTurns';

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

    it('does not create an empty activity group for a persisted empty thinking block', () => {
        const emptyThinking: Message = {
            kind: 'agent-text',
            id: 'empty-thinking',
            localId: null,
            createdAt: 2,
            text: '**',
            isThinking: true,
        };
        const rows = buildChatRows([
            user('u1', 1),
            emptyThinking,
            finalAgent('final', 3, 58_000),
        ], false);

        expect(rows.map((row) => row.type)).toEqual(['message', 'message']);
        expect(rows.map((row) => row.key)).toEqual(['u1', 'final']);
    });

    it('keeps the live-status fallback free of an empty activity disclosure', () => {
        const emptyThinking: Message = {
            kind: 'agent-text',
            id: 'empty-thinking-live',
            localId: null,
            createdAt: 2,
            text: '**',
            isThinking: true,
        };
        const rows = buildChatRows([
            user('u1', 1),
            emptyThinking,
        ], true);

        expect(rows.map((row) => row.type)).toEqual(['message']);
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

/* ── B-355: 附件归属到 user 轮次 ─────────────────────────────────────────── */

const fileEvent = (id: string, createdAt: number, name = 'a.png'): Message => ({
    kind: 'tool-call', id, localId: null, createdAt, children: [],
    tool: {
        name: 'file', state: 'completed',
        input: { ref: `ref-${id}`, name, mimeType: 'image/png', size: 2048 },
        createdAt, startedAt: createdAt, completedAt: createdAt, description: `Attached file: ${name}`,
    },
} as Message);

const rowKinds = (rows: ReturnType<typeof buildChatRows>) => rows.map((r) => r.type);

describe('extractUserAttachments (B-355)', () => {
    it('S1 — session opens with attachments + text: no toolgroup, files ride the user row', () => {
        const rows = buildChatRows([fileEvent('f1', 1), fileEvent('f2', 2), user('u1', 3)], false);
        expect(rowKinds(rows)).toEqual(['message']);
        expect(rows[0]).toMatchObject({ type: 'message', message: { id: 'u1' } });
        expect((rows[0] as { attachments?: Message[] }).attachments?.map((m) => m.id)).toEqual(['f1', 'f2']);
    });

    it('S2 — previous turn ended with a final agent message', () => {
        const rows = buildChatRows([user('u0', 1), finalAgent('a1', 2, 500), fileEvent('f1', 3), user('u1', 4)], false);
        const last = rows[rows.length - 1] as { attachments?: Message[] };
        expect(last).toMatchObject({ type: 'message', message: { id: 'u1' } });
        expect(last.attachments?.map((m) => m.id)).toEqual(['f1']);
        // the file must not survive as a tool row anywhere
        expect(rows.some((r) => r.type === 'toolgroup')).toBe(false);
    });

    it('S3 — previous turn had NO final agent text: the file must not vanish into the activity drawer', () => {
        const rows = buildChatRows([user('u0', 1), tool('t1', 2), fileEvent('f1', 3), user('u1', 4)], false);
        const activity = rows.find((r) => r.type === 'activity') as { messages: Message[] } | undefined;
        expect(activity?.messages.map((m) => m.id)).toEqual(['t1']);
        const last = rows[rows.length - 1] as { attachments?: Message[] };
        expect(last.attachments?.map((m) => m.id)).toEqual(['f1']);
    });

    it('S4 — live session behaves like S2', () => {
        const rows = buildChatRows([user('u0', 1), finalAgent('a1', 2, 100), fileEvent('f1', 3), user('u1', 4)], true);
        const last = rows[rows.length - 1] as { attachments?: Message[] };
        expect(last.attachments?.map((m) => m.id)).toEqual(['f1']);
    });

    it('an orphan file event (nothing sent with it) stays visible as a tool row', () => {
        const rows = buildChatRows([user('u0', 1), fileEvent('f1', 2), agent('a1', 3)], false);
        const everyMessage = JSON.stringify(rows);
        expect(everyMessage).toContain('f1');
        expect(rows.some((r) => r.type === 'toolgroup' || r.type === 'activity')).toBe(true);
    });

    it('leaves a transcript without attachments byte-identical (memo identity)', () => {
        const messages = [user('u1', 1), tool('t1', 2), agent('a1', 3)];
        const { messages: out } = extractUserAttachments(messages);
        expect(out).toBe(messages);
    });
});

describe('attachments are only attached to a message that renders a bubble', () => {
    const notification: Message = {
        kind: 'user-text', id: 'n1', localId: null, createdAt: 5,
        text: '<task-notification><summary>done</summary><status>completed</status></task-notification>',
    } as Message;

    it('a task-notification owner keeps the file visible as a tool row instead', () => {
        const { messages: kept, attachments } = extractUserAttachments([fileEvent('f1', 4), notification]);
        expect(attachments.size).toBe(0);
        expect(kept.map((m) => m.id)).toEqual(['f1', 'n1']);
    });

    it('a supervisor tick owner does the same (it renders a card, not a bubble)', () => {
        const tick: Message = {
            kind: 'user-text', id: 'k1', localId: null, createdAt: 5,
            // same shape supervisorCards.test.ts uses for a report with no items
            text: readFileSync(new URL('./__fixtures__/vh-tick.txt', import.meta.url), 'utf8'),
        } as Message;
        const { attachments } = extractUserAttachments([fileEvent('f1', 4), tick]);
        expect(attachments.size).toBe(0);
    });

    it('an ordinary user message still gets them', () => {
        const { attachments } = extractUserAttachments([fileEvent('f1', 4), user('u1', 5)]);
        expect(attachments.get('u1')?.map((m) => m.id)).toEqual(['f1']);
    });
});
