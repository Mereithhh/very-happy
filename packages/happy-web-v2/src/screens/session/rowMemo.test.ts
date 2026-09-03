import { describe, expect, it } from 'vitest';
import { sameItems } from './rowMemo';

describe('sameItems', () => {
    it('treats a rebuilt array of the same elements as equal', () => {
        const a = { id: 1 };
        const b = { id: 2 };
        // This is the case that matters: buildChatRows hands back a NEW array
        // every render while the reducer keeps the message objects stable.
        expect(sameItems([a, b], [a, b])).toBe(true);
    });

    it('detects a changed element, a reorder, and a length change', () => {
        const a = { id: 1 };
        const b = { id: 2 };
        expect(sameItems([a, b], [a, { id: 2 }])).toBe(false);
        expect(sameItems([a, b], [b, a])).toBe(false);
        expect(sameItems([a, b], [a])).toBe(false);
    });

    it('short-circuits on identity and handles empties', () => {
        const list = [{ id: 1 }];
        expect(sameItems(list, list)).toBe(true);
        expect(sameItems([], [])).toBe(true);
    });
});
