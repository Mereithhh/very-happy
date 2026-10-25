/** B-814: what a tab does with outbox rows it took over (spec B-807 §5.5.3). */
import { describe, expect, it } from 'vitest';
import type { OutboxRow } from './cache/outboxStore';
import { planOutboxAdoption } from './outboxAdoption';

function row(localId: string, patch: Partial<OutboxRow> = {}): OutboxRow {
    return { localId, sid: 's', body: `c-${localId}`, createdAt: 10, state: 'queued', attempts: 0, ownerTabId: 'me', group: 'g', order: 0, ...patch };
}

const none = { tracked: () => false, inTranscript: () => false };

describe('planOutboxAdoption', () => {
    it('queued → re-send, failed → stale, in send order (createdAt, then order within a turn)', () => {
        const plan = planOutboxAdoption([
            { row: row('text', { createdAt: 20, order: 1 }), raw: 'r' },
            { row: row('file', { createdAt: 20, order: 0 }), raw: 'r' },
            { row: row('first', { createdAt: 5 }), raw: 'r' },
            { row: row('old', { state: 'failed' }), raw: 'r' },
        ], none);
        expect(plan.resend.map((c) => c.row.localId)).toEqual(['first', 'file', 'text']);
        expect(plan.stale.map((c) => c.row.localId)).toEqual(['old']);
        expect(plan.drop).toEqual([]);
    });

    it('a row the server already stored (its localId is in the transcript) is dropped, never re-sent or shown', () => {
        const plan = planOutboxAdoption([{ row: row('a'), raw: 'r' }, { row: row('b', { state: 'failed' }), raw: 'r' }],
            { tracked: () => false, inTranscript: (id) => id === 'a' || id === 'b' });
        expect(plan).toEqual({ resend: [], stale: [], drop: ['a', 'b'] });
    });

    it('a row this tab already tracks (B-801 first message re-sent with the same localId) is left alone', () => {
        const plan = planOutboxAdoption([{ row: row('a'), raw: 'r' }], { tracked: (id) => id === 'a', inTranscript: () => true });
        expect(plan).toEqual({ resend: [], stale: [], drop: [] });
    });

    it('an undecryptable row is dropped', () => {
        expect(planOutboxAdoption([{ row: row('a'), raw: null }], none).drop).toEqual(['a']);
    });
});
