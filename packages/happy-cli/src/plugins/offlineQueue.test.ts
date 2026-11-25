import { describe, expect, it } from 'vitest';
import { OfflineQueue, OFFLINE_QUEUE_LIMIT } from './offlineQueue';

const op = (key: string, o: string, payload: Record<string, unknown> = {}, queuedAt = 0) => ({ key, op: o, payload, queuedAt });

describe('B-974c offline queue (DESIGN §5.1)', () => {
    it('keeps one entry per key, newest wins and moves to the end', () => {
        const q = new OfflineQueue();
        q.enqueue('i', op('badge', 'badge.put', { count: 1 }));
        q.enqueue('i', op('widget:s1', 'widget.put', { x: 1 }));
        q.enqueue('i', op('badge', 'badge.put', { count: 2 }));
        expect(q.items('i').map((i) => [i.key, i.payload])).toEqual([['widget:s1', { x: 1 }], ['badge', { count: 2 }]]);
        q.enqueue('i', op('widget:s1', 'widget.delete', { sessionId: 's1' }));
        expect(q.items('i').map((i) => i.op)).toEqual(['badge.put', 'widget.delete']);
    });

    it('a queued create survives a later partial update', () => {
        const q = new OfflineQueue();
        q.enqueue('i', op('decision:k', 'decision.post', { key: 'k', kind: 'notice', title: 'a' }));
        q.enqueue('i', op('decision:k', 'decision.patch', { key: 'k', title: 'b' }));
        expect(q.items('i')).toMatchObject([{ op: 'decision.post', payload: { key: 'k', kind: 'notice', title: 'b' } }]);
        q.enqueue('i', op('decision:k', 'decision.delete', { key: 'k' }));
        expect(q.items('i')).toMatchObject([{ op: 'decision.delete' }]);
    });

    it(`caps each install at ${OFFLINE_QUEUE_LIMIT} keys; existing keys still update when full`, () => {
        const q = new OfflineQueue();
        for (let n = 0; n < OFFLINE_QUEUE_LIMIT; n++) expect(q.enqueue('i', op(`decision:${n}`, 'decision.post'))).toBe(true);
        expect(q.enqueue('i', op('decision:new', 'decision.post'))).toBe(false);
        expect(q.size('i')).toBe(OFFLINE_QUEUE_LIMIT);
        expect(q.enqueue('i', op('decision:5', 'decision.delete'))).toBe(true);
        expect(q.size('i')).toBe(OFFLINE_QUEUE_LIMIT);
        expect(q.enqueue('other', op('badge', 'badge.put'))).toBe(true);
    });

    it('replays in order and stops at the first offline answer', async () => {
        const saved: unknown[] = [];
        const q = new OfflineQueue((_id, items) => saved.push(items.length));
        for (const k of ['a', 'b', 'c']) q.enqueue('i', op(k, 'badge.put'));
        const sent: string[] = [];
        expect(await q.drain('i', async (item) => { if (item.key === 'b') return 'offline'; sent.push(item.key); return 'sent'; })).toBe(1);
        expect(sent).toEqual(['a']);
        expect(q.items('i').map((i) => i.key)).toEqual(['b', 'c']);
        expect(await q.drain('i', async (item) => { sent.push(item.key); return 'sent'; })).toBe(2);
        expect(sent).toEqual(['a', 'b', 'c']);
        expect(q.size('i')).toBe(0);
        expect(saved.at(-1)).toBe(0);
    });
});
