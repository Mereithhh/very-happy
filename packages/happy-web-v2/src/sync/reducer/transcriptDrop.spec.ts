import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '../typesRaw';
import { createReducer, isDroppedBySeq, reducer } from './reducer';

const user = (id: string, seq: number | null, text = id): NormalizedMessage => ({
    id, localId: `local-${id}`, createdAt: 1000 + (seq ?? 99), seq, role: 'user', isSidechain: false,
    content: { type: 'text', text },
});
const agent = (id: string, seq: number): NormalizedMessage => ({
    id, localId: null, createdAt: 1000 + seq, seq, role: 'agent', isSidechain: false,
    content: [{ type: 'text', text: `answer ${id}`, uuid: id, parentUUID: null }],
} as NormalizedMessage);
const drop = (id: string, seq: number | null, fromSeq: number, toSeq?: number): NormalizedMessage => ({
    id, localId: id, createdAt: 5000, seq, role: 'event', isSidechain: false,
    content: { type: 'transcript-drop', fromSeq, ...(toSeq !== undefined ? { toSeq } : {}), reason: 'edit' },
});

describe('transcript-drop (B-528)', () => {
    it('an optimistic edit tombstone hides everything from fromSeq until its echo closes the range', () => {
        const state = createReducer();
        const visible = reducer(state, [user('u1', 1), agent('a1', 2), user('u2', 3), agent('a2', 4)]).messages;
        expect(visible.map((m) => m.seq)).toEqual([1, 2, 3, 4]);

        expect(reducer(state, [drop('d1', null, 3)]).messages).toHaveLength(0);
        expect([1, 2, 3, 4, 7].map((seq) => isDroppedBySeq(state, seq))).toEqual([false, false, true, true, true]);
        expect(isDroppedBySeq(state, null)).toBe(false);

        // The echo carries the server seq: the edited prompt that follows is visible again.
        reducer(state, [drop('d1', 5, 3)]);
        expect([3, 4, 5, 6].map((seq) => isDroppedBySeq(state, seq))).toEqual([true, true, false, false]);
    });

    it('a delete tombstone hides exactly [fromSeq, toSeq) and applies to history that loads later', () => {
        const state = createReducer();
        reducer(state, [drop('d2', 9, 3, 5)]);
        reducer(state, [user('u3', 5), agent('a2', 4), user('u2', 3), agent('a1', 2)]);
        expect([2, 3, 4, 5].map((seq) => isDroppedBySeq(state, seq))).toEqual([false, true, true, false]);
    });

    it('never renders the tombstone itself', () => {
        const state = createReducer();
        reducer(state, [user('u1', 1)]);
        expect(reducer(state, [drop('d3', 2, 1)]).messages).toEqual([]);
    });
});
