import { describe, expect, it } from 'vitest';
import {
    UNREAD_MAX_AGE_MS,
    UNREAD_MAX_KEYS,
    nextUnreadRecord,
    parseUnreadRecord,
    pruneUnreadRecord,
    unreadIdsOf,
} from './sidebarUnread';

const NOW = 1_700_000_000_000;

describe('sidebarUnread', () => {
    it('parses a stored record and rejects every malformed shape', () => {
        expect(parseUnreadRecord(JSON.stringify({ a: NOW }))).toEqual({ a: NOW });
        expect(parseUnreadRecord(undefined)).toEqual({});
        expect(parseUnreadRecord('')).toEqual({});
        expect(parseUnreadRecord('not json')).toEqual({});
        expect(parseUnreadRecord('[1,2]')).toEqual({});
        expect(parseUnreadRecord('null')).toEqual({});
        // a v0 blob (plain id array) and non-numeric stamps degrade to "nothing unread"
        expect(parseUnreadRecord('["a","b"]')).toEqual({});
        expect(parseUnreadRecord(JSON.stringify({ a: 'x', b: NaN, c: NOW }))).toEqual({ c: NOW });
    });

    it('drops dots older than the age window, keeps the rest', () => {
        const record = {
            fresh: NOW - 1000,
            edge: NOW - UNREAD_MAX_AGE_MS + 1,
            stale: NOW - UNREAD_MAX_AGE_MS,
            ancient: NOW - 10 * UNREAD_MAX_AGE_MS,
        };
        expect(Object.keys(pruneUnreadRecord(record, NOW)).sort()).toEqual(['edge', 'fresh']);
    });

    it('caps at the newest UNREAD_MAX_KEYS ids', () => {
        const record: Record<string, number> = {};
        for (let i = 0; i < UNREAD_MAX_KEYS + 25; i++) record[`s${i}`] = NOW - i * 1000;
        const pruned = pruneUnreadRecord(record, NOW);
        expect(Object.keys(pruned)).toHaveLength(UNREAD_MAX_KEYS);
        expect(pruned.s0).toBe(NOW); // newest survives
        expect(pruned[`s${UNREAD_MAX_KEYS + 24}`]).toBeUndefined(); // oldest evicted
    });

    it('keeps each id ORIGINAL markedAt across writes, so the age guard measures the turn', () => {
        const previous = { a: NOW - 6 * 24 * 60 * 60 * 1000 };
        const later = NOW + 60_000;
        const next = nextUnreadRecord(previous, ['a', 'b'], later);
        expect(next.a).toBe(previous.a); // NOT refreshed to `later`
        expect(next.b).toBe(later);
    });

    it('an id dropped from the set disappears from the record', () => {
        const next = nextUnreadRecord({ a: NOW, b: NOW }, ['b'], NOW);
        expect(unreadIdsOf(next)).toEqual(['b']);
    });

    it('an id whose markedAt already aged out is not resurrected by a rewrite', () => {
        const previous = { old: NOW - UNREAD_MAX_AGE_MS - 1 };
        expect(nextUnreadRecord(previous, ['old'], NOW)).toEqual({});
    });
});
