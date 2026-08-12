import { describe, it, expect } from 'vitest';
import {
  sortRowsByManualOrder,
  mergeLegacyPinned,
  planSidebarOrder,
  moveEntryToTop,
  pruneEntries,
  type SidebarOrderEntry,
} from './sidebarOrder';

const E = (...pairs: Array<[string, string]>): SidebarOrderEntry[] =>
  pairs.map(([key, order]) => ({ key, order }));

/** rows helper: keys with descending createdAt in argument order (first =
 *  newest) unless an explicit ts is given */
const R = (...keys: Array<string | [string, number]>) =>
  keys.map((k, i) =>
    typeof k === 'string' ? { key: k, createdAt: 1000 - i } : { key: k[0], createdAt: k[1] },
  );

const keysOf = (rows: Array<{ key: string }>) => rows.map((r) => r.key);

/** render order implied by a plan — sanity-check plans through the same
 *  comparator the sidebar uses */
const renderOrder = (rows: ReturnType<typeof R>, entries: SidebarOrderEntry[]) =>
  keysOf(sortRowsByManualOrder(rows, entries));

describe('sortRowsByManualOrder', () => {
  it('keyed rows sort by their order strings, regardless of input order', () => {
    const rows = R('c', 'a', 'b');
    const out = sortRowsByManualOrder(rows, E(['a', 'A'], ['b', 'B'], ['c', 'C']));
    expect(keysOf(out)).toEqual(['a', 'b', 'c']);
  });

  it('unkeyed rows render ON TOP, newest createdAt first', () => {
    const rows = R(['old', 10], ['newer', 30], ['newest', 40], ['keyed', 99]);
    const out = sortRowsByManualOrder(rows, E(['keyed', 'M']));
    expect(keysOf(out)).toEqual(['newest', 'newer', 'old', 'keyed']);
  });

  it('equal order strings tiebreak on the row key (total order everywhere)', () => {
    const rows = R('b', 'a');
    const out = sortRowsByManualOrder(rows, E(['a', 'M'], ['b', 'M']));
    expect(keysOf(out)).toEqual(['a', 'b']);
  });

  it('entries with no matching row are simply ignored (no ghosts)', () => {
    const rows = R('a');
    const out = sortRowsByManualOrder(rows, E(['ghost', 'A'], ['a', 'B']));
    expect(keysOf(out)).toEqual(['a']);
  });
});

describe('mergeLegacyPinned', () => {
  it('all pinned keys visible → sequence unchanged', () => {
    expect(mergeLegacyPinned(['p1', 'p2', 'x'], ['p1', 'p2'])).toEqual(['p1', 'p2', 'x']);
  });

  it('invisible pinned keys are inserted after their pinned predecessor', () => {
    // p2 has no visible row (its machine is not loaded); it must survive the
    // materialization at its position between p1 and p3.
    expect(mergeLegacyPinned(['p1', 'p3', 'x'], ['p1', 'p2', 'p3'])).toEqual([
      'p1',
      'p2',
      'p3',
      'x',
    ]);
  });

  it('leading invisible pinned key goes to the top', () => {
    expect(mergeLegacyPinned(['a', 'b'], ['ghost'])).toEqual(['ghost', 'a', 'b']);
  });

  it('duplicate pinned entries are deduped', () => {
    expect(mergeLegacyPinned(['a'], ['g', 'g'])).toEqual(['g', 'a']);
  });

  it('no pins → identity', () => {
    expect(mergeLegacyPinned(['a', 'b'], [])).toEqual(['a', 'b']);
  });
});

describe('planSidebarOrder', () => {
  it('materializes a whole sequence from empty (first drag)', () => {
    const out = planSidebarOrder([], ['a', 'b', 'c']);
    expect(out.map((e) => e.key)).toEqual(['a', 'b', 'c']);
    // strictly increasing keys → renders in exactly this order
    expect(renderOrder(R('c', 'a', 'b'), out)).toEqual(['a', 'b', 'c']);
  });

  it('moving one row touches ONLY that row (minimal write)', () => {
    const entries = E(['a', 'B'], ['b', 'M'], ['c', 'X']);
    // drag c between a and b
    const out = planSidebarOrder(entries, ['a', 'c', 'b'], 'c');
    const untouched = out.filter((e) => e.key !== 'c');
    expect(untouched).toEqual(E(['a', 'B'], ['b', 'M']));
    const c = out.find((e) => e.key === 'c')!;
    expect(c.order > 'B' && c.order < 'M').toBe(true);
    expect(renderOrder(R('a', 'b', 'c'), out)).toEqual(['a', 'c', 'b']);
  });

  it('adjacent swap via the menu (move up/down semantics)', () => {
    const entries = E(['a', 'B'], ['b', 'M'], ['c', 'X']);
    const out = planSidebarOrder(entries, ['b', 'a', 'c'], 'a');
    expect(renderOrder(R('a', 'b', 'c'), out)).toEqual(['b', 'a', 'c']);
    expect(out.find((e) => e.key === 'b')!.order).toBe('M');
    expect(out.find((e) => e.key === 'c')!.order).toBe('X');
  });

  it('unkeyed visible rows are materialized in place (new-row zone)', () => {
    const entries = E(['a', 'M'], ['b', 'X']);
    // "n" is a new row sitting on top; user drags a above b (n untouched)
    const out = planSidebarOrder(entries, ['n', 'a', 'b'], 'a');
    expect(out.map((e) => e.key).sort()).toEqual(['a', 'b', 'n']);
    expect(renderOrder(R('a', 'b', 'n'), out)).toEqual(['n', 'a', 'b']);
  });

  it('re-keys everything when kept keys are not strictly increasing', () => {
    const entries = E(['a', 'X'], ['b', 'B']); // corrupt: display a-then-b but X > B
    const out = planSidebarOrder(entries, ['a', 'b'], undefined);
    expect(renderOrder(R('a', 'b'), out)).toEqual(['a', 'b']);
    const a = out.find((e) => e.key === 'a')!;
    const b = out.find((e) => e.key === 'b')!;
    expect(a.order < b.order).toBe(true);
  });

  it('carries invisible entries untouched', () => {
    const entries = E(['ghost', 'G'], ['a', 'M'], ['b', 'X']);
    const out = planSidebarOrder(entries, ['b', 'a'], 'b');
    expect(out.find((e) => e.key === 'ghost')).toEqual({ key: 'ghost', order: 'G' });
  });

  it('returns the SAME array on a no-op drop (no settings write)', () => {
    const entries = E(['a', 'B'], ['b', 'M'], ['c', 'X']);
    expect(planSidebarOrder(entries, ['a', 'b', 'c'], 'b')).toBe(entries);
  });

  it('first-drag materialization folds legacy pins in at the top', () => {
    // legacy state: p pinned (visible on top), invisible pin g; user's first
    // drag moves c above b: display seq after the move = [p, a, c, b]
    const seq = mergeLegacyPinned(['p', 'a', 'c', 'b'], ['p', 'g']);
    const out = planSidebarOrder([], seq, 'c');
    expect(renderOrder(R('a', 'b', 'c', 'p', 'g'), out)).toEqual(['p', 'g', 'a', 'c', 'b']);
  });
});

describe('moveEntryToTop', () => {
  it('moves an existing entry above the current minimum', () => {
    const entries = E(['a', 'B'], ['b', 'M']);
    const out = moveEntryToTop(entries, 'b');
    expect(renderOrder(R('a', 'b'), out)).toEqual(['b', 'a']);
  });

  it('inserts a missing key at the top', () => {
    const entries = E(['a', 'M']);
    const out = moveEntryToTop(entries, 'x');
    expect(renderOrder(R('a', 'x'), out)).toEqual(['x', 'a']);
  });

  it('no-op (same array) when the key is already strictly on top', () => {
    const entries = E(['a', 'B'], ['b', 'M']);
    expect(moveEntryToTop(entries, 'a')).toBe(entries);
  });

  it('empty entries → untouched (caller handles the legacy path)', () => {
    const entries: SidebarOrderEntry[] = [];
    expect(moveEntryToTop(entries, 'a')).toBe(entries);
  });
});

describe('pruneEntries', () => {
  it('drops keys not in the valid set', () => {
    expect(pruneEntries(E(['a', 'A'], ['dead', 'D'], ['b', 'B']), new Set(['a', 'b']))).toEqual(
      E(['a', 'A'], ['b', 'B']),
    );
  });
  it('returns null when nothing changed (no settings write)', () => {
    expect(pruneEntries(E(['a', 'A']), new Set(['a']))).toBeNull();
  });
  it('works for the legacy pinnedRows shape too', () => {
    expect(pruneEntries([{ key: 'a' }, { key: 'x' }], new Set(['a']))).toEqual([{ key: 'a' }]);
  });
});
