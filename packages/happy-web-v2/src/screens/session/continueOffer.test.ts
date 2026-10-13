import { describe, expect, it } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import { buildChatRows } from './chatTurns';
import { continueOfferStopId } from './continueOffer';

const user = (id: string, createdAt: number, text = id): Message => ({ kind: 'user-text', id, localId: null, createdAt, text });
const agent = (id: string, createdAt: number): Message => ({ kind: 'agent-text', id, localId: null, createdAt, text: id });
const event = (id: string, createdAt: number, message: string): Message => ({
    kind: 'agent-event', id, createdAt, event: { type: 'message', message },
} as Message);
const tool = (id: string, createdAt: number): Message => ({
    kind: 'tool-call', id, localId: null, createdAt, children: [],
    tool: { name: 'Task', state: 'completed', input: {}, createdAt, startedAt: createdAt, completedAt: createdAt + 1, description: null },
} as Message);
const stop = (id: string, createdAt: number) => event(id, createdAt, 'Aborted by user');

describe('continueOfferStopId (B-578)', () => {
    it('offers on the latest stop only while nothing user-side follows it', () => {
        expect(continueOfferStopId([user('u1', 1), stop('s1', 2), user('u2', 3), agent('a', 4), stop('s2', 5)])).toBe('s2');
        expect(continueOfferStopId([user('u1', 1), stop('s1', 2), agent('late', 3)])).toBe('s1');
        expect(continueOfferStopId([user('u1', 1), stop('s1', 2), user('u2', 3)])).toBeNull();
        // a task notification also picked the agent back up
        expect(continueOfferStopId([user('u1', 1), stop('s1', 2), user('n', 3, '<task-notification><summary>done</summary><status>completed</status></task-notification>')])).toBeNull();
        expect(continueOfferStopId([user('u1', 1), event('e', 2, 'Process exited unexpectedly')])).toBeNull();
        expect(continueOfferStopId([user('u1', 1), event('t', 2, 'turn aborted')])).toBe('t');
    });

    it('marks exactly that row, and lifts the stop of an answerless turn out of the fold', () => {
        const rows = buildChatRows([user('u1', 1), stop('old', 2), user('u2', 3), tool('task', 4), stop('s', 9)], false);
        expect(rows.map((row) => row.type)).toEqual(['message', 'message', 'message', 'activity', 'message']);
        const offered = rows.filter((row) => row.type === 'message' && row.continueOffer);
        expect(offered).toHaveLength(1);
        expect(offered[0]).toMatchObject({ message: { id: 's' } });
        // the folded sub-agent card still learns about the stop (B-317)
        expect(rows[3]).toMatchObject({ type: 'activity', messages: [{ id: 'task' }], abortedAt: 9 });
    });

    it('keeps the stop after an answered turn as its own row', () => {
        const rows = buildChatRows([user('u1', 1), agent('answer', 2), stop('s', 3)], false);
        expect(rows.map((row) => row.type === 'message' ? row.message.id : row.type)).toEqual(['u1', 'answer', 's']);
        expect(rows[2]).toMatchObject({ continueOffer: true });
    });

    it('does not lift anything out of a live turn', () => {
        const rows = buildChatRows([user('u1', 1), tool('task', 2), stop('s', 3)], true);
        expect(rows.map((row) => row.type)).toEqual(['message', 'activity']);
    });

});

describe('「继续」 text (B-578)', () => {
    it('is one key per language, so what the button shows is what gets sent', async () => {
        const { en } = await import('@/text/_default');
        const { zhHans } = await import('@/text/translations/zh-Hans');
        const { zhHant } = await import('@/text/translations/zh-Hant');
        expect(en.session.chat.readingAids.continue).toBe('Continue');
        expect(zhHans.session.chat.readingAids.continue).toBe('继续');
        expect(zhHant.session?.chat?.readingAids?.continue).toBe('繼續');
    });
});
