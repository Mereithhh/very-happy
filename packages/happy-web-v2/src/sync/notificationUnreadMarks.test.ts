import { describe, expect, it } from 'vitest';
import {
    entryReadAction,
    isUnreadWithMarks,
    parseUnreadMarks,
    UNREAD_MARKS_CAP,
    withMark,
    withoutMark,
} from './notificationUnreadMarks';
import { isEntryUnread } from './notificationSeen';

const entry = { id: 'e1', key: 's1', createdAt: 1_000 };

describe('isUnreadWithMarks (B-559: mark-unread AND cross-device seen)', () => {
    it('an unmarked entry keeps the base verdict', () => {
        expect(isUnreadWithMarks(true, entry, {}, {})).toBe(true);
        expect(isUnreadWithMarks(false, entry, {}, {})).toBe(false);
    });

    it('marking a read entry makes it unread', () => {
        const seen = { s1: 2_000 }; // already read via seen
        expect(isEntryUnread(true, entry, seen)).toBe(false);
        expect(isUnreadWithMarks(false, entry, { e1: 3_000 }, seen)).toBe(true);
    });

    it('a visit to the target AFTER the mark (any device) retires it', () => {
        expect(isUnreadWithMarks(false, entry, { e1: 3_000 }, { s1: 3_000 })).toBe(false);
        expect(isUnreadWithMarks(false, entry, { e1: 3_000 }, { s1: 4_000 })).toBe(false);
    });

    it('a visit BEFORE the mark does not retire it', () => {
        expect(isUnreadWithMarks(false, entry, { e1: 3_000 }, { s1: 2_999 })).toBe(true);
    });

    it('an empty/unavailable seen map degrades to "marked ⇒ unread"', () => {
        expect(isUnreadWithMarks(false, entry, { e1: 3_000 }, {})).toBe(true);
    });

    it('marks are per entry, not per target', () => {
        expect(isUnreadWithMarks(false, { id: 'e2', key: 's1' }, { e1: 3_000 }, {})).toBe(false);
    });
});

describe('mark bookkeeping', () => {
    it('withoutMark is a no-op (same object) when absent, removes otherwise', () => {
        const m = { a: 1 };
        expect(withoutMark(m, 'b')).toBe(m);
        expect(withoutMark(m, 'a')).toEqual({});
    });

    it('withMark evicts the oldest marks beyond the cap', () => {
        let m = {};
        for (let i = 0; i < UNREAD_MARKS_CAP + 5; i++) m = withMark(m, `id${i}`, 1_000 + i);
        expect(Object.keys(m)).toHaveLength(UNREAD_MARKS_CAP);
        expect('id0' in m).toBe(false);
        expect(`id${UNREAD_MARKS_CAP + 4}` in m).toBe(true);
    });

    it('parseUnreadMarks drops junk', () => {
        expect(parseUnreadMarks({ a: 5, b: 'x', c: -1, d: Infinity, '': 3 })).toEqual({ a: 5 });
        expect(parseUnreadMarks(null)).toEqual({});
        expect(parseUnreadMarks([1, 2])).toEqual({});
    });
});

describe('entryReadAction', () => {
    it('unread → mark read (also for the open target)', () => {
        expect(entryReadAction({ unread: true, key: 's1' }, 's1')).toBe('markRead');
    });
    it('read → mark unread, except for the target open right now', () => {
        expect(entryReadAction({ unread: false, key: 's1' }, 's2')).toBe('markUnread');
        expect(entryReadAction({ unread: false, key: 's1' }, null)).toBe('markUnread');
        expect(entryReadAction({ unread: false, key: 's1' }, 's1')).toBeNull();
    });
});
