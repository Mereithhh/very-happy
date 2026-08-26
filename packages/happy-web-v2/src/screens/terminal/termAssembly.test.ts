/**
 * Transition-table coverage for the deep-history assembly machine
 * (spec 2026-08-terminal-channel-v2 §D1「assembly 状态机」).
 *
 * The two rules the spec marks as self-destruct points get their own blocks:
 *  - the COPY rule is independent of the state (a chunk applied at any point
 *    after the baseline must survive into the rebuild — a missed one is erased
 *    by the rebuild's reset and the screen forks from reality for good);
 *  - during a rebuild only the WRITE is deferred, and deferred chunks are ALWAYS
 *    handed back to be written — including on an abort, because their seq was
 *    already accepted and no catch-up will replay them.
 */
import { describe, it, expect } from 'vitest';
import {
    createTermAssembly,
    prefixAlternateEnter,
    ALT_SCREEN_ENTER,
    ASSEMBLY_MAX_BUFFER_BYTES,
    type TermAssembly,
} from './termAssembly';

const bytes = (s: string) => new TextEncoder().encode(s);
const join = (chunks: Uint8Array[]) => chunks.map((c) => new TextDecoder().decode(c)).join('');

/** Drive an assembly to `awaiting-quiet` with `n` pages of known content. */
function withPages(n: number, a: TermAssembly = createTermAssembly()): TermAssembly {
    a.start({ snapshotId: 'snap-1', totalPages: n });
    for (let i = 0; i < n; i++) a.pageArrived(a.generation, i, bytes(`p${i}`));
    return a;
}

describe('start', () => {
    it('enters buffering and bumps the generation', () => {
        const a = createTermAssembly();
        expect(a.state).toBe('idle');
        expect(a.start({ snapshotId: 's', totalPages: 3 })).toBe(true);
        expect(a.state).toBe('buffering');
        expect(a.generation).toBe(1);
        expect(a.snapshotId).toBe('s');
        expect(a.totalPages).toBe(3);
    });

    it('is a no-op assembly when there is nothing to page (totalPages <= 0)', () => {
        const a = createTermAssembly();
        expect(a.start({ snapshotId: 's', totalPages: 0 })).toBe(false);
        expect(a.state).toBe('done');
        // Inert: live chunks are written straight through, nothing retained.
        expect(join(a.noteLiveChunk(bytes('x')))).toBe('x');
        expect(a.liveBytes).toBe(0);
    });

    it('is a no-op assembly without a snapshotId (partial daemon response)', () => {
        const a = createTermAssembly();
        expect(a.start({ snapshotId: '', totalPages: 4 })).toBe(false);
        expect(a.state).toBe('done');
    });

    it('supersedes a run in flight — old pages and copies are dropped', () => {
        const a = withPages(2);
        a.noteLiveChunk(bytes('live'));
        const oldGen = a.generation;
        a.start({ snapshotId: 'snap-2', totalPages: 1 });
        expect(a.generation).toBe(oldGen + 1);
        expect(a.state).toBe('buffering');
        expect(a.pagesReceived).toBe(0);
        expect(a.liveBytes).toBe(0);
        // A page from the superseded run must not land in the new one.
        expect(a.pageArrived(oldGen, 0, bytes('stale'))).toBe('stale');
        expect(a.pagesReceived).toBe(0);
    });
});

describe('pageArrived', () => {
    it('completes out of order and moves to awaiting-quiet on the last page', () => {
        const a = createTermAssembly();
        a.start({ snapshotId: 's', totalPages: 3 });
        expect(a.pageArrived(a.generation, 2, bytes('c'))).toBe('ok');
        expect(a.state).toBe('buffering');
        expect(a.pageArrived(a.generation, 0, bytes('a'))).toBe('ok');
        expect(a.state).toBe('buffering');
        expect(a.pageArrived(a.generation, 1, bytes('b'))).toBe('ok');
        expect(a.state).toBe('awaiting-quiet');
        // Pages are replayed in PAGE order, not arrival order.
        expect(join(a.tryRebuild(true)!.pages)).toBe('abc');
    });

    it('ignores duplicates (a retry landing twice must not double-count)', () => {
        const a = createTermAssembly();
        a.start({ snapshotId: 's', totalPages: 2 });
        expect(a.pageArrived(a.generation, 0, bytes('a'))).toBe('ok');
        expect(a.pageArrived(a.generation, 0, bytes('a'))).toBe('duplicate');
        expect(a.pagesReceived).toBe(1);
        expect(a.state).toBe('buffering');
    });

    it('rejects out-of-range pages and pages outside buffering', () => {
        const a = createTermAssembly();
        a.start({ snapshotId: 's', totalPages: 2 });
        expect(a.pageArrived(a.generation, 5, bytes('x'))).toBe('stale');
        expect(a.pageArrived(a.generation, -1, bytes('x'))).toBe('stale');
        a.pageArrived(a.generation, 0, bytes('a'));
        a.pageArrived(a.generation, 1, bytes('b'));
        expect(a.state).toBe('awaiting-quiet');
        expect(a.pageArrived(a.generation, 0, bytes('a'))).toBe('stale');
    });

    it('aborts when the paged bytes blow past the cap', () => {
        const a = createTermAssembly(64);
        a.start({ snapshotId: 's', totalPages: 2 });
        a.pageArrived(a.generation, 0, new Uint8Array(40));
        expect(a.state).toBe('buffering');
        a.pageArrived(a.generation, 1, new Uint8Array(40));
        expect(a.state).toBe('done');
        expect(a.lastAbortReason).toBe('buffer-overflow');
    });
});

describe('copy rule (independent of state)', () => {
    it('keeps chunks applied while pages are still in flight', () => {
        const a = createTermAssembly();
        a.start({ snapshotId: 's', totalPages: 2 });
        expect(join(a.noteLiveChunk(bytes('L1')))).toBe('L1'); // written now
        a.pageArrived(a.generation, 0, bytes('p0'));
        expect(join(a.noteLiveChunk(bytes('L2')))).toBe('L2');
        a.pageArrived(a.generation, 1, bytes('p1'));
        const plan = a.tryRebuild(true)!;
        expect(join(plan.pages)).toBe('p0p1');
        expect(join(plan.copies)).toBe('L1L2');
    });

    it('keeps copying while the quiet gate holds the rebuild back', () => {
        const a = withPages(1);
        expect(a.state).toBe('awaiting-quiet');
        a.noteLiveChunk(bytes('A'));
        expect(a.tryRebuild(false)).toBeNull(); // user is selecting / scrolled up
        expect(a.state).toBe('awaiting-quiet');
        a.noteLiveChunk(bytes('B'));
        expect(a.tryRebuild(false)).toBeNull();
        a.noteLiveChunk(bytes('C'));
        const plan = a.tryRebuild(true)!;
        // Not one of them may be missing: the rebuild's reset erases whatever
        // was on screen, so an uncopied chunk is gone for good.
        expect(join(plan.copies)).toBe('ABC');
    });

    it('preserves chunk boundaries exactly (xterm UTF-8 decoder is stateful)', () => {
        const a = withPages(1);
        const half1 = new Uint8Array([0xe4, 0xb8]);
        const half2 = new Uint8Array([0xad]);
        a.noteLiveChunk(half1);
        a.noteLiveChunk(half2);
        const plan = a.tryRebuild(true)!;
        expect(plan.copies.map((c) => Array.from(c))).toEqual([[0xe4, 0xb8], [0xad]]);
    });

    it('retains nothing before start or after done', () => {
        const a = createTermAssembly();
        expect(join(a.noteLiveChunk(bytes('pre')))).toBe('pre');
        expect(a.liveBytes).toBe(0);
        withPages(1, a);
        a.abort('gap');
        expect(join(a.noteLiveChunk(bytes('post')))).toBe('post');
        expect(a.liveBytes).toBe(0);
    });
});

describe('rebuilding', () => {
    it('defers live writes but hands them back in order when done', () => {
        const a = withPages(1);
        a.noteLiveChunk(bytes('before'));
        const plan = a.tryRebuild(true)!;
        expect(a.state).toBe('rebuilding');
        expect(join(plan.copies)).toBe('before');
        expect(a.noteLiveChunk(bytes('D1'))).toEqual([]);
        expect(a.noteLiveChunk(bytes('D2'))).toEqual([]);
        expect(join(a.finishRebuild())).toBe('D1D2');
        expect(a.state).toBe('done');
    });

    it('tryRebuild is a no-op outside awaiting-quiet', () => {
        const a = createTermAssembly();
        expect(a.tryRebuild(true)).toBeNull(); // idle
        a.start({ snapshotId: 's', totalPages: 2 });
        expect(a.tryRebuild(true)).toBeNull(); // buffering — pages not in yet
        a.pageArrived(a.generation, 0, bytes('a'));
        expect(a.tryRebuild(true)).toBeNull();
        a.pageArrived(a.generation, 1, bytes('b'));
        expect(a.tryRebuild(true)).not.toBeNull(); // awaiting-quiet
        expect(a.tryRebuild(true)).toBeNull(); // rebuilding — no second plan
        a.finishRebuild();
        expect(a.tryRebuild(true)).toBeNull(); // done
    });

    it('finishRebuild outside rebuilding returns nothing and changes nothing', () => {
        const a = withPages(1);
        expect(a.finishRebuild()).toEqual([]);
        expect(a.state).toBe('awaiting-quiet');
    });

    it('an abort mid-rebuild still hands back the deferred chunks', () => {
        // Their seq was already accepted by termStreamSync, so a catch-up will
        // never replay them — dropping them is a permanent content hole.
        const a = withPages(1);
        a.tryRebuild(true);
        a.noteLiveChunk(bytes('D1'));
        a.noteLiveChunk(bytes('D2'));
        expect(join(a.abort('gap'))).toBe('D1D2');
        expect(a.state).toBe('done');
        expect(a.lastAbortReason).toBe('gap');
    });

    it('a mid-rebuild overflow flushes everything deferred and gives up', () => {
        const a = createTermAssembly(8);
        a.start({ snapshotId: 's', totalPages: 1 });
        a.pageArrived(a.generation, 0, bytes('p'));
        a.tryRebuild(true);
        expect(a.noteLiveChunk(bytes('1234'))).toEqual([]);
        const flushed = a.noteLiveChunk(bytes('56789'));
        expect(join(flushed)).toBe('123456789'); // nothing lost, order kept
        expect(a.state).toBe('done');
        expect(a.lastAbortReason).toBe('buffer-overflow');
    });
});

describe('abort paths (all land in done, no undo needed)', () => {
    for (const reason of ['gap', 'snapshot-expired', 'page-failed', 'initial-timeout', 'disposed', 'superseded'] as const) {
        it(`abort(${reason}) from buffering releases everything`, () => {
            const a = createTermAssembly();
            a.start({ snapshotId: 's', totalPages: 2 });
            a.pageArrived(a.generation, 0, bytes('p0'));
            a.noteLiveChunk(bytes('live'));
            expect(a.abort(reason)).toEqual([]); // nothing was deferred
            expect(a.state).toBe('done');
            expect(a.lastAbortReason).toBe(reason);
            expect(a.liveBytes).toBe(0);
            expect(a.pageBytes).toBe(0);
            expect(a.snapshotId).toBeNull();
        });
    }

    it('abort from awaiting-quiet releases the buffered pages', () => {
        const a = withPages(2);
        expect(a.abort('snapshot-expired')).toEqual([]);
        expect(a.state).toBe('done');
        expect(a.pageBytes).toBe(0);
    });

    it('abort is idempotent and inert in idle/done', () => {
        const a = createTermAssembly();
        expect(a.abort('disposed')).toEqual([]);
        expect(a.lastAbortReason).toBeNull(); // never entered a run
        withPages(1, a);
        a.abort('gap');
        expect(a.abort('page-failed')).toEqual([]);
        expect(a.lastAbortReason).toBe('gap'); // second abort is a no-op
    });

    it('a live overflow while buffering aborts but still writes the chunk', () => {
        const a = createTermAssembly(8);
        a.start({ snapshotId: 's', totalPages: 2 });
        expect(join(a.noteLiveChunk(bytes('12345')))).toBe('12345');
        expect(a.state).toBe('buffering');
        expect(join(a.noteLiveChunk(bytes('6789')))).toBe('6789');
        expect(a.state).toBe('done');
        expect(a.lastAbortReason).toBe('buffer-overflow');
    });

    it('the default cap is the 2MB the spec pins to the daemon ring', () => {
        expect(ASSEMBLY_MAX_BUFFER_BYTES).toBe(2 * 1024 * 1024);
    });
});

describe('prefixAlternateEnter', () => {
    it('passes normal-screen snapshots through untouched', () => {
        const d = bytes('hello');
        expect(prefixAlternateEnter(d, false)).toBe(d);
    });

    it('prefixes \\x1b[?1049h when the pane was on the alternate screen', () => {
        const out = prefixAlternateEnter(bytes('vim'), true);
        expect(Array.from(out.slice(0, ALT_SCREEN_ENTER.length))).toEqual(Array.from(ALT_SCREEN_ENTER));
        expect(new TextDecoder().decode(out.slice(ALT_SCREEN_ENTER.length))).toBe('vim');
    });

    it('is idempotent when the daemon already prefixed it', () => {
        const already = prefixAlternateEnter(bytes('vim'), true);
        expect(prefixAlternateEnter(already, true)).toBe(already);
    });

    it('handles a payload shorter than the escape sequence', () => {
        const out = prefixAlternateEnter(bytes('x'), true);
        expect(out.length).toBe(ALT_SCREEN_ENTER.length + 1);
    });
});
