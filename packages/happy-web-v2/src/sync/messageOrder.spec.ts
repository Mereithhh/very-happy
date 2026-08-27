import { describe, it, expect } from 'vitest';
import { compareMessagesNewestFirst } from './messageOrder';
import type { Message } from './typesMessage';

/**
 * compareMessagesNewestFirst is the single comparator behind the chat list
 * (inverted list: index 0 renders at the visual bottom). Three-level key:
 * seq (server conversation order) → createdAt → sortOrder (reducer counter).
 */

function msg(id: string, opts: { seq?: number | null; createdAt: number; sortOrder?: number }): Message {
    return {
        kind: 'user-text',
        id,
        localId: null,
        text: id,
        createdAt: opts.createdAt,
        seq: opts.seq,
        sortOrder: opts.sortOrder,
    };
}

function ids(list: Message[]): string[] {
    return [...list].sort(compareMessagesNewestFirst).map(m => (m as any).id);
}

describe('compareMessagesNewestFirst', () => {
    describe('level 1: seq', () => {
        it('orders by seq descending when both sides have seq', () => {
            const a = msg('a', { seq: 1, createdAt: 1000 });
            const b = msg('b', { seq: 2, createdAt: 1000 });
            expect(compareMessagesNewestFirst(a, b)).toBeGreaterThan(0);
            expect(compareMessagesNewestFirst(b, a)).toBeLessThan(0);
        });

        it('seq wins even when createdAt disagrees (server order is authoritative)', () => {
            // Clock skew / same-transaction stamping can make createdAt lie;
            // seq must still decide.
            const older = msg('older', { seq: 1, createdAt: 9999 });
            const newer = msg('newer', { seq: 2, createdAt: 1 });
            expect(ids([older, newer])).toEqual(['newer', 'older']);
        });

        it('falls through to createdAt when seq ties', () => {
            const a = msg('a', { seq: 5, createdAt: 1000 });
            const b = msg('b', { seq: 5, createdAt: 2000 });
            expect(ids([a, b])).toEqual(['b', 'a']);
        });
    });

    describe('level 2: createdAt (either side missing seq)', () => {
        it('uses createdAt when one side has no seq (locally synthesized message)', () => {
            const server = msg('server', { seq: 10, createdAt: 1000 });
            const local = msg('local', { seq: null, createdAt: 2000 });
            expect(ids([server, local])).toEqual(['local', 'server']);
        });

        it('uses createdAt when neither side has seq', () => {
            const a = msg('a', { createdAt: 3000 });
            const b = msg('b', { createdAt: 1000 });
            expect(ids([b, a])).toEqual(['a', 'b']);
        });

        it('treats undefined and null seq the same (both bypass level 1)', () => {
            const u = msg('u', { seq: undefined, createdAt: 1000 });
            const n = msg('n', { seq: null, createdAt: 2000 });
            expect(ids([u, n])).toEqual(['n', 'u']);
        });
    });

    describe('level 3: sortOrder (createdAt tie)', () => {
        it('breaks a createdAt tie by sortOrder (blocks of one source message)', () => {
            // Several blocks of one source message share seq and createdAt;
            // the reducer creates them in content order with a monotonic counter.
            const text = msg('text', { seq: 7, createdAt: 1000, sortOrder: 0 });
            const tool = msg('tool', { seq: 7, createdAt: 1000, sortOrder: 1 });
            expect(ids([text, tool])).toEqual(['tool', 'text']);
        });

        it('breaks a createdAt tie for seq-less messages (POSTed batch stamped with one timestamp)', () => {
            const first = msg('first', { createdAt: 1000, sortOrder: 3 });
            const second = msg('second', { createdAt: 1000, sortOrder: 4 });
            expect(ids([second, first])).toEqual(['second', 'first']);
        });

        it('returns 0 when all keys tie or sortOrder is missing (stable sort keeps order)', () => {
            const a = msg('a', { seq: 1, createdAt: 1000, sortOrder: 2 });
            const b = msg('b', { seq: 1, createdAt: 1000, sortOrder: 2 });
            expect(compareMessagesNewestFirst(a, b)).toBe(0);
            const c = msg('c', { createdAt: 1000 });
            const d = msg('d', { createdAt: 1000 });
            expect(compareMessagesNewestFirst(c, d)).toBe(0);
        });
    });

    describe('backward pagination interleaving', () => {
        it('sorts a newest-first, DESC-within-page backfill into seq order regardless of arrival order', () => {
            // Server history: seq 1..6. Backfill delivers page A (newest, seq 6,5,4)
            // then page B (seq 3,2,1); a realtime message (seq 7) lands in between.
            const pageA = [msg('m6', { seq: 6, createdAt: 6000 }), msg('m5', { seq: 5, createdAt: 5000 }), msg('m4', { seq: 4, createdAt: 4000 })];
            const realtime = [msg('m7', { seq: 7, createdAt: 7000 })];
            const pageB = [msg('m3', { seq: 3, createdAt: 3000 }), msg('m2', { seq: 2, createdAt: 2000 }), msg('m1', { seq: 1, createdAt: 1000 })];
            const arrival = [...pageA, ...realtime, ...pageB];
            expect(ids(arrival)).toEqual(['m7', 'm6', 'm5', 'm4', 'm3', 'm2', 'm1']);
        });

        it('keeps an optimistic local send at its wall-clock position among server messages', () => {
            const history = [
                msg('m1', { seq: 1, createdAt: 1000 }),
                msg('m2', { seq: 2, createdAt: 2000 }),
            ];
            // Optimistic send after m2, before the server echoes it back.
            const optimistic = msg('local', { seq: null, createdAt: 2500 });
            expect(ids([...history, optimistic])).toEqual(['local', 'm2', 'm1']);
        });
    });

    it('places consumed queued input at its turn-end display boundary without mutating source seq', () => {
        const queued = msg('queued', { seq: 5, createdAt: 500 });
        queued.displaySeq = 9;
        queued.displayAt = 900;
        const laterTool = msg('tool', { seq: 8, createdAt: 800 });
        const nextReply = msg('reply', { seq: 10, createdAt: 1000 });

        expect(ids([laterTool, nextReply, queued])).toEqual(['reply', 'queued', 'tool']);
        expect(queued.seq).toBe(5);
    });
});
