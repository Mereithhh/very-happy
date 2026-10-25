/**
 * B-812 (B-807 spec §5.1, §9.2-2/3/4/8/9/10): the single merge entry.
 * Pure: drives `planMerge` on a cursor the way sync.ts' mergeSessionMessages
 * does, plus the source assertion that nothing else writes the store.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCursor, expireReorder, planMerge, PENDING_LIMIT, REORDER_WINDOW_MS, resetCursor, type MergeItem, type MergeSource, type SessionCursor } from './sessionMerge';

type M = { id: string; seq: number };
const msg = (seq: number): M => ({ id: `m${seq}`, seq });
const items = (...seqs: number[]): MergeItem<M>[] => seqs.map((seq) => ({ seq, message: msg(seq) }));
const acks = (...seqs: number[]): MergeItem<M>[] => seqs.map((seq) => ({ seq, message: null }));

/** A store that reduces like the real one for this purpose: dedupe by id, render by seq. */
function harness(cursor: SessionCursor<M> = createCursor()) {
    const store = new Map<string, M>();
    const applied: number[][] = [];
    let now = 0;
    const merge = (batch: MergeItem<M>[], source: MergeSource, meta: Record<string, unknown> = {}) => {
        const plan = planMerge(cursor, batch, source, { now, ...meta });
        if (plan.resetWindow) store.clear();
        applied.push(plan.apply.map((m) => m.seq));
        for (const m of plan.apply) store.set(m.id, m);
        return plan;
    };
    return {
        cursor, store, applied, merge,
        advance: (ms: number) => { now += ms; return expireReorder(cursor, now); },
        seqs: () => [...store.values()].map((m) => m.seq).sort((a, b) => a - b),
    };
}

function anchored(lastSeq: number) {
    const h = harness();
    h.merge(items(...Array.from({ length: lastSeq }, (_, i) => i + 1)), 'latest-page');
    h.applied.length = 0;
    return h;
}

describe('B-812 merge: point vs range sources (spec r1 §5.1-3)', () => {
    it('point sources advance through a contiguous run only; past a hole they wait in the reorder buffer', () => {
        const h = anchored(10);
        let plan = h.merge(items(11), 'push');
        expect(plan.apply.map((m) => m.seq)).toEqual([11]);
        expect(h.cursor.lastSeq).toBe(11);

        plan = h.merge(items(13), 'push');
        expect(plan.apply).toEqual([]);
        expect(h.cursor.lastSeq).toBe(11);
        expect(h.cursor.reorderDeadline).toBe(REORDER_WINDOW_MS);

        plan = h.merge(items(12), 'relay-committed');
        expect(plan.apply.map((m) => m.seq)).toEqual([12, 13]);
        expect(h.cursor.lastSeq).toBe(13);
        expect(h.cursor.reorderDeadline).toBeUndefined();
    });

    it('a send ack is a point source too: our N+2 does not jump over the agent\'s N+1 (B-513)', () => {
        const h = anchored(10);
        h.merge(acks(12), 'send-ack');
        expect(h.cursor.lastSeq).toBe(10);
        h.merge(items(11), 'push');
        expect(h.cursor.lastSeq).toBe(12);
        expect(h.seqs()).toContain(11);
    });

    it('echoes (seq <= lastSeq) are dropped', () => {
        const h = anchored(10);
        expect(h.merge(items(9, 10), 'push').apply).toEqual([]);
        expect(h.cursor.lastSeq).toBe(10);
    });

    it('range sources: a seq missing inside the range does not exist — no gap, lastSeq moves past it', () => {
        const h = anchored(4);
        // Server range (4, 10]: rows 6–10, 5 is a permanent hole.
        const plan = h.merge(items(6, 7, 8, 9, 10), 'snapshot', { afterSeq: 4, headSeq: 10, hasMore: false });
        expect(plan.outcome).toBe('merged');
        expect(plan.live).toBe(true);
        expect(h.cursor.lastSeq).toBe(10);
        expect(h.cursor.reorderDeadline).toBeUndefined();
        // REST forward (no head): moves to the page's newest row.
        const rest = anchored(4);
        rest.merge(items(6, 8), 'rest', { hasMore: false });
        expect(rest.cursor.lastSeq).toBe(8);
        expect(rest.cursor.reorderDeadline).toBeUndefined();
    });

    it('older pages move oldestSeq down to the page minimum and leave lastSeq alone', () => {
        const h = harness();
        h.merge(items(101, 102, 103), 'latest-page');
        expect(h.cursor.oldestSeq).toBe(101);
        h.merge(items(1, 2, 3, 50, 100), 'older-page');
        expect(h.cursor.oldestSeq).toBe(1);
        expect(h.cursor.lastSeq).toBe(103);
    });

    it('a range result drains the reorder buffer it covers and cancels the gap', () => {
        const h = anchored(10);
        h.merge(items(13), 'push');
        expect(h.cursor.reorderDeadline).toBeDefined();
        const plan = h.merge(items(11, 12, 13), 'snapshot', { afterSeq: 10, headSeq: 13, hasMore: false });
        expect(plan.apply.map((m) => m.seq)).toEqual([11, 12, 13]);
        expect(h.cursor.lastSeq).toBe(13);
        expect(h.cursor.pending.size).toBe(0);
        expect(h.cursor.reorderDeadline).toBeUndefined();
    });
});

describe('B-812 merge: head (spec r1 §5.1-5, §9.2-9/10)', () => {
    it('§9.2-9 tail hole: hasMore=false moves lastSeq to the head although the newest row is below it → live', () => {
        const h = anchored(10);
        const plan = h.merge([], 'snapshot', { afterSeq: 10, headSeq: 12, hasMore: false });
        expect(plan.outcome).toBe('merged');
        expect(plan.live).toBe(true);
        expect(h.cursor.lastSeq).toBe(12);
        // The next real message is seq 13: contiguous, no gap.
        expect(h.merge(items(13), 'push').apply.map((m) => m.seq)).toEqual([13]);
        expect(h.cursor.reorderDeadline).toBeUndefined();
    });

    it('§9.2-9 cold variant: the latest page 1–10 with head 12 anchors at 12', () => {
        const h = harness();
        const plan = h.merge(items(...Array.from({ length: 10 }, (_, i) => i + 1)), 'latest-page', { afterSeq: null, headSeq: 12, hasMore: false });
        expect(plan.live).toBe(true);
        expect(h.cursor.lastSeq).toBe(12);
        expect(h.cursor.oldestSeq).toBe(1);
    });

    it('§9.2-10a headSeq < request afterSeq is the one inconsistency: nothing applied, outcome head-behind', () => {
        const h = anchored(10);
        const plan = h.merge(items(7, 8), 'snapshot', { afterSeq: 10, headSeq: 8, hasMore: false });
        expect(plan.outcome).toBe('head-behind');
        expect(plan.apply).toEqual([]);
        expect(h.cursor.lastSeq).toBe(10);
        // After the reset the cold page is accepted at the lower head.
        resetCursor(h.cursor);
        const cold = h.merge(items(7, 8), 'latest-page', { afterSeq: null, headSeq: 8, hasMore: false, generation: h.cursor.generation });
        expect(cold.outcome).toBe('merged');
        expect(h.cursor.lastSeq).toBe(8);
    });

    it('§9.2-10b race: a push past the snapshot head lands before the ack — not an inconsistency, lastSeq stays', () => {
        const h = anchored(10);
        h.merge(items(11), 'push'); // pushed after the snapshot began, delivered first
        const plan = h.merge([], 'snapshot', { afterSeq: 10, headSeq: 10, hasMore: false });
        expect(plan.outcome).toBe('merged');
        expect(plan.live).toBe(true);
        expect(h.cursor.lastSeq).toBe(11);
        expect(h.seqs()).toContain(11);
    });

    it('rows outside (afterSeq, headSeq] cannot come from one snapshot: invalid, nothing applied', () => {
        const h = anchored(10);
        expect(h.merge(items(11, 14), 'snapshot', { afterSeq: 10, headSeq: 13, hasMore: false }).outcome).toBe('invalid');
        expect(h.merge(items(9, 11), 'snapshot', { afterSeq: 10, headSeq: 13, hasMore: false }).outcome).toBe('invalid');
        expect(h.cursor.lastSeq).toBe(10);
    });

    it('hasMore=true is not live; lastSeq moves to the last row only', () => {
        const h = anchored(10);
        const plan = h.merge(items(11, 12), 'snapshot', { afterSeq: 10, headSeq: 40, hasMore: true });
        expect(plan.live).toBe(false);
        expect(h.cursor.lastSeq).toBe(12);
    });

    it('gapTooLarge: the latest page resets the window and the cursor', () => {
        const h = anchored(10);
        const plan = h.merge(items(800, 801), 'latest-page', { afterSeq: 10, headSeq: 801, hasMore: false, gapTooLarge: true });
        expect(plan.resetWindow).toBe(true);
        expect(h.seqs()).toEqual([800, 801]);
        expect(h.cursor.lastSeq).toBe(801);
        expect(h.cursor.oldestSeq).toBe(800);
    });
});

describe('B-812 merge: rule 1 generation, rule 4 reorder, B-805 anchor', () => {
    it('a range result of a superseded generation is dropped; live facts are not', () => {
        const h = anchored(10);
        h.cursor.generation = 3;
        expect(h.merge(items(11), 'snapshot', { afterSeq: 10, headSeq: 11, hasMore: false, generation: 2 }).outcome).toBe('superseded');
        expect(h.merge(items(11), 'rest', { generation: 2 }).outcome).toBe('superseded');
        expect(h.cursor.lastSeq).toBe(10);
        expect(h.merge(items(11), 'push', { generation: 0 }).apply).toHaveLength(1);
    });

    it('§9.2-4 N+2 then N+1 within 400ms → no gap; past 400ms → one gap range', () => {
        const h = anchored(10);
        h.merge(items(12), 'push');
        expect(h.advance(REORDER_WINDOW_MS - 1)).toBeNull();
        h.merge(items(11), 'push');
        expect(h.advance(10)).toBeNull();
        expect(h.cursor.lastSeq).toBe(12);

        h.merge(items(15), 'push');
        expect(h.advance(REORDER_WINDOW_MS - 1)).toBeNull();
        expect(h.advance(1)).toEqual({ from: 13, to: 14 });
        // Reported once; the catch-up it starts fills the hole.
        expect(h.advance(REORDER_WINDOW_MS)).toBeNull();
    });

    it('before the first page: point items are buffered, the first asks for the page once, the page drains them', () => {
        const h = harness();
        expect(h.merge(items(5), 'push').needAnchor).toBe(true);
        expect(h.merge(items(6), 'push').needAnchor).toBe(false);
        expect(h.merge(items(8), 'push').apply).toEqual([]);
        const plan = h.merge(items(1, 2, 3, 4, 5), 'latest-page');
        // 5 is covered by the page; 6 runs on; 8 stays behind the hole at 7.
        expect(plan.apply.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6]);
        expect(h.cursor.lastSeq).toBe(6);
        expect(h.advance(REORDER_WINDOW_MS)).toEqual({ from: 7, to: 7 });
    });

    it('B-813 B1: a cached run anchors at its stored lastSeq (holes included); buffered pushes apply only where they continue it', () => {
        const h = harness();
        h.merge(items(9), 'push'); // first live update asks for the page
        h.merge(items(6), 'push');
        h.merge(items(5), 'push');
        // Cached rows 1–3, stored lastSeq 4 (seq 4 is a hole).
        const plan = h.merge(items(1, 2, 3), 'cache', { headSeq: 4 });
        expect(plan.live).toBe(false);
        expect(plan.effects).toEqual([]);
        expect(plan.apply.map((m) => m.seq)).toEqual([1, 2, 3, 5, 6]);
        expect(h.cursor.lastSeq).toBe(6);
        expect(h.cursor.oldestSeq).toBe(1);
        // 9 waits behind the hole at 7–8 for the catch-up's range.
        expect(h.seqs()).not.toContain(9);
        h.merge(items(7, 8, 9), 'rest', { hasMore: false });
        expect(h.seqs()).toEqual([1, 2, 3, 5, 6, 7, 8, 9]);
    });

    it('an empty REST first page anchors at 0', () => {
        const h = harness();
        h.merge([], 'latest-page');
        expect(h.cursor.lastSeq).toBe(0);
        expect(h.merge(items(1), 'push').apply).toHaveLength(1);
    });

    it('the pre-anchor buffer is bounded; items past it surface as a gap instead of being skipped', () => {
        const h = harness();
        for (let seq = 2; seq <= PENDING_LIMIT + 10; seq += 1) h.merge(items(seq), 'push');
        expect(h.cursor.pending.size).toBe(PENDING_LIMIT);
        h.merge(items(1), 'latest-page');
        expect(h.cursor.lastSeq).toBe(PENDING_LIMIT + 1);
        expect(h.advance(REORDER_WINDOW_MS)).toBeNull(); // nothing buffered past the run
        expect(h.merge(items(PENDING_LIMIT + 11), 'push').apply).toEqual([]);
        expect(h.advance(REORDER_WINDOW_MS)).toEqual({ from: PENDING_LIMIT + 2, to: PENDING_LIMIT + 10 });
    });
});

describe('B-812 merge: rule 6 side effects (§9.2-3)', () => {
    it('a push of a new seq carries effects; a replay of it does not', () => {
        const h = anchored(10);
        expect(h.merge(items(11), 'push').effects.map((i) => i.seq)).toEqual([11]);
        expect(h.merge(items(11), 'push').effects).toEqual([]);
    });

    it('cache, older-page and latest-page never carry effects', () => {
        for (const source of ['cache', 'older-page', 'latest-page', 'relay-committed', 'send-ack', 'snapshot', 'rest'] as const) {
            const h = source === 'cache' ? harness() : anchored(10);
            expect(h.merge(items(11), source, { afterSeq: 10, headSeq: 11, hasMore: false }).effects).toEqual([]);
        }
    });

    it('a catch-up that landed first does not swallow the effects of the push that follows it', () => {
        const h = anchored(10);
        h.merge(items(11), 'rest');
        expect(h.merge(items(11), 'push').effects.map((i) => i.seq)).toEqual([11]);
    });

    it('pushes of a never-opened session still carry effects (sidebar thinking)', () => {
        const h = harness();
        expect(h.merge(items(5), 'push').effects.map((i) => i.seq)).toEqual([5]);
    });
});

describe('B-812 merge: property (§9.2-2)', () => {
    /** Deterministic PRNG so a failure reproduces. */
    function rng(seed: number) {
        let x = seed >>> 0 || 1;
        return () => {
            x ^= x << 13; x >>>= 0;
            x ^= x >>> 17;
            x ^= x << 5; x >>>= 0;
            return x / 0x1_0000_0000;
        };
    }

    it('any interleaving of sources, order and duplicates converges to the deduped seq set; lastSeq never decreases', () => {
        for (let run = 0; run < 300; run += 1) {
            const random = rng(run + 1);
            const total = 5 + Math.floor(random() * 40);
            // A few permanent holes, like old sessions (§4.2.1).
            const exists = new Set<number>();
            for (let seq = 1; seq <= total; seq += 1) if (random() > 0.12) exists.add(seq);
            const head = total;
            const all = [...exists].sort((a, b) => a - b);
            const h = harness();
            let lastSeq = -1;
            const check = () => {
                const now = h.cursor.lastSeq ?? -1;
                expect(now).toBeGreaterThanOrEqual(lastSeq);
                lastSeq = now;
            };
            // Initial: a latest page of the first k rows (as if the session were that long then).
            const k = Math.floor(random() * all.length);
            h.merge(items(...all.slice(0, k)), 'latest-page', { afterSeq: null, headSeq: all[k - 1] ?? 0, hasMore: false });
            check();
            const steps = 20 + Math.floor(random() * 40);
            for (let step = 0; step < steps; step += 1) {
                const r = random();
                if (r < 0.45) {
                    const seq = all[Math.floor(random() * all.length)];
                    h.merge(items(seq), random() < 0.8 ? 'push' : 'relay-committed');
                } else if (r < 0.6) {
                    const seq = all[Math.floor(random() * all.length)];
                    h.merge(acks(seq), 'send-ack');
                    h.store.set(`m${seq}`, msg(seq)); // our own message: reduced optimistically
                } else if (r < 0.8) {
                    const after = h.cursor.lastSeq ?? 0;
                    const page = all.filter((seq) => seq > after);
                    h.merge(items(...page), 'snapshot', { afterSeq: after, headSeq: head, hasMore: false, generation: h.cursor.generation });
                } else if (r < 0.9) {
                    const after = h.cursor.lastSeq ?? 0;
                    h.merge(items(...all.filter((seq) => seq > after).slice(0, 3)), 'rest', {});
                } else {
                    h.advance(REORDER_WINDOW_MS);
                }
                check();
            }
            // Final reconcile (what the gap / hello / 120s path does).
            const after = h.cursor.lastSeq ?? 0;
            const plan = h.merge(items(...all.filter((seq) => seq > after)), 'snapshot', { afterSeq: after, headSeq: head, hasMore: false, generation: h.cursor.generation });
            expect(plan.live).toBe(true);
            check();
            expect(h.seqs()).toEqual(all);
            expect(h.cursor.lastSeq).toBe(head);
            expect(h.cursor.pending.size).toBe(0);
        }
    });
});

describe('B-812 source assertion (§5.1 migration, §9.2-8)', () => {
    const source = readFileSync(resolve(__dirname, 'sync.ts'), 'utf8');

    it('sync.ts writes messages to the store in exactly one place, reached only from the merge entry and local inputs', () => {
        expect(source.match(/storage\.getState\(\)\.applyMessages\(/g)).toHaveLength(1);
        const writer = source.slice(source.indexOf('    private writeMessagesToStore = '), source.indexOf('    private applySessions = '));
        expect(writer).toContain('storage.getState().applyMessages(');
        const callers = [...source.matchAll(/this\.writeMessagesToStore\(/g)].map((match) => {
            const before = source.slice(0, match.index);
            const method = before.match(/\n {4}(?:private |public |readonly )?(?:async )?([A-Za-z]+)\s*(?:=\s*(?:async\s*)?)?\(/g)?.at(-1) ?? '';
            return method.trim().replace(/^(private|public|readonly)\s+/, '').replace(/[\s=(].*$/, '');
        });
        expect(new Set(callers)).toEqual(new Set(['mergeSessionMessages', 'applyOptimistic', 'applyLocalMessages']));
    });

    it('no cursor write outside the merge entry: lastSeq / oldestSeq are only read in sync.ts', () => {
        expect(source).not.toMatch(/\.lastSeq\s*=[^=]/);
        expect(source).not.toMatch(/\.oldestSeq\s*=[^=]/);
        expect(source).not.toMatch(/sessionLastSeq|sessionOldestSeq|anchorBuffer/);
    });
});
