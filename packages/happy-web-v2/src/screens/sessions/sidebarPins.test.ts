/**
 * LEGACY pinnedRows helpers — only what the transition window still uses
 * (see sidebarPins.ts). The reorder semantics that used to live here
 * (togglePin / movePin / reorderPin / prunePinned) migrated to the full
 * manual-order model — see sidebarOrder.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { splitPinnedRows, upsertPinAt, type PinnedRow } from './sidebarPins';

const P = (...keys: string[]): PinnedRow[] => keys.map((key) => ({ key }));
const R = (...keys: string[]) => keys.map((key) => ({ key }));

describe('splitPinnedRows (legacy pre-materialization display)', () => {
  it('pinned rows come out in PIN-ARRAY order, rest keeps input order', () => {
    const rows = R('a', 'b', 'c', 'd');
    const { pinned, rest } = splitPinnedRows(rows, P('c', 'a'));
    expect(pinned.map((r) => r.key)).toEqual(['c', 'a']);
    expect(rest.map((r) => r.key)).toEqual(['b', 'd']);
  });

  it('pinned keys with no matching row are skipped (deleted/archived/filtered)', () => {
    const rows = R('a', 'b');
    const { pinned, rest } = splitPinnedRows(rows, P('ghost', 'b'));
    expect(pinned.map((r) => r.key)).toEqual(['b']);
    expect(rest.map((r) => r.key)).toEqual(['a']);
  });

  it('duplicate pin entries only claim the row once', () => {
    const rows = R('a', 'b');
    const { pinned, rest } = splitPinnedRows(rows, P('a', 'a'));
    expect(pinned.map((r) => r.key)).toEqual(['a']);
    expect(rest.map((r) => r.key)).toEqual(['b']);
  });

  it('no pins → everything in rest', () => {
    const rows = R('a', 'b');
    const { pinned, rest } = splitPinnedRows(rows, []);
    expect(pinned).toEqual([]);
    expect(rest.map((r) => r.key)).toEqual(['a', 'b']);
  });
});

describe('upsertPinAt (legacy board "move to top" while unmaterialized)', () => {
  it('inserts an unpinned key at the given position', () => {
    expect(upsertPinAt(P('a', 'b'), 'x', 0)).toEqual(P('x', 'a', 'b'));
    expect(upsertPinAt(P('a', 'b'), 'x', 1)).toEqual(P('a', 'x', 'b'));
    expect(upsertPinAt(P('a', 'b'), 'x', 2)).toEqual(P('a', 'b', 'x'));
  });

  it('pins into an empty list', () => {
    expect(upsertPinAt([], 'x', 0)).toEqual(P('x'));
  });

  it('moves an already-pinned key (index counted with the key removed)', () => {
    expect(upsertPinAt(P('a', 'b', 'c'), 'a', 1)).toEqual(P('b', 'a', 'c'));
    expect(upsertPinAt(P('a', 'b', 'c'), 'c', 0)).toEqual(P('c', 'a', 'b'));
  });

  it('clamps out-of-range targets', () => {
    expect(upsertPinAt(P('a', 'b'), 'x', 99)).toEqual(P('a', 'b', 'x'));
    expect(upsertPinAt(P('a', 'b'), 'x', -1)).toEqual(P('x', 'a', 'b'));
  });

  it('returns the SAME array on a no-op (no settings write)', () => {
    const pins = P('a', 'b', 'c');
    expect(upsertPinAt(pins, 'a', 0)).toBe(pins);
  });

  it('duplicate entries of the key collapse into one at the target', () => {
    expect(upsertPinAt(P('a', 'x', 'b', 'x'), 'x', 0)).toEqual(P('x', 'a', 'b'));
  });
});
