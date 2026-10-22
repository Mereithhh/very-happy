// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { AttentionItem } from '@slopus/happy-wire';
import { needsYouOf, withItemAttention } from './needsYou';

const it_ = (over: Partial<AttentionItem>): AttentionItem => ({
    id: Math.random().toString(36), sessionId: 's', teamId: null, projectId: null, source: 'lead', kind: 'decision', key: null, title: 't',
    bodyMd: null, options: null, links: null, anchor: null, firstReply: null, replyToId: null, inferred: false, needsOwner: true, state: 'open',
    ownerChoice: null, ownerNote: null, resolvedBy: null, resolveNote: null, repostCount: 0, createdAt: 1, updatedAt: 1, resolvedAt: null,
    pushedAt: null, version: 1, ...over,
});

describe('needsYou (B-766 W-2)', () => {
    it('counts open needs-owner items, one row per session, plus automation sessions', () => {
        const n = needsYouOf({
            a: [it_({ sessionId: 'a' }), it_({ sessionId: 'a', kind: 'todo' }), it_({ sessionId: 'a', kind: 'report', needsOwner: false })],
            b: [it_({ sessionId: 'b', state: 'resolved' })],
            c: [it_({ sessionId: 'c', kind: 'blocked', inferred: true, state: 'in_progress' })],
        }, new Set(['z', 'a']), 2);
        expect(n.items).toBe(3);
        expect([...n.itemSessionIds].sort()).toEqual(['a', 'c']);
        expect([...n.sessionIds].sort()).toEqual(['a', 'c', 'z']);
        expect(n.automations).toBe(2);
    });
    it('item sessions join the urgent-band row keys without dropping any', () => {
        expect([...withItemAttention(new Set(['t:1', 'x']), new Set(['x', 'y']))].sort()).toEqual(['t:1', 'x', 'y']);
    });
});
