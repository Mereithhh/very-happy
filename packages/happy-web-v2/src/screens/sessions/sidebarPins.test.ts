import { describe, it, expect } from 'vitest';
import {
  splitPinnedRows,
  isPinned,
  togglePin,
  movePin,
  reorderPin,
  upsertPinAt,
  prunePinned,
  type PinnedRow,
} from './sidebarPins';

const P = (...keys: string[]): PinnedRow[] => keys.map((key) => ({ key }));
const R = (...keys: string[]) => keys.map((key) => ({ key }));

describe('splitPinnedRows', () => {
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

describe('togglePin / isPinned', () => {
  it('pin appends at the END of the pinned section', () => {
    expect(togglePin(P('a'), 'b')).toEqual(P('a', 'b'));
  });
  it('unpin removes', () => {
    expect(togglePin(P('a', 'b'), 'a')).toEqual(P('b'));
  });
  it('isPinned', () => {
    expect(isPinned(P('a'), 'a')).toBe(true);
    expect(isPinned(P('a'), 'b')).toBe(false);
  });
});

describe('movePin', () => {
  it('moves up/down one step', () => {
    expect(movePin(P('a', 'b', 'c'), 'c', -1)).toEqual(P('a', 'c', 'b'));
    expect(movePin(P('a', 'b', 'c'), 'a', 1)).toEqual(P('b', 'a', 'c'));
  });
  it('no-op at the edges and for unknown keys', () => {
    const pins = P('a', 'b');
    expect(movePin(pins, 'a', -1)).toBe(pins);
    expect(movePin(pins, 'b', 1)).toBe(pins);
    expect(movePin(pins, 'x', 1)).toBe(pins);
  });
});

describe('reorderPin', () => {
  it('moves an entry to a new index (drag semantics)', () => {
    expect(reorderPin(P('a', 'b', 'c', 'd'), 0, 2)).toEqual(P('b', 'c', 'a', 'd'));
    expect(reorderPin(P('a', 'b', 'c', 'd'), 3, 0)).toEqual(P('d', 'a', 'b', 'c'));
  });
  it('clamps out-of-range targets and no-ops on same index', () => {
    expect(reorderPin(P('a', 'b'), 0, 99)).toEqual(P('b', 'a'));
    const pins = P('a', 'b');
    expect(reorderPin(pins, 1, 1)).toBe(pins);
    expect(reorderPin(pins, -1, 0)).toBe(pins);
  });
});

describe('upsertPinAt', () => {
  it('inserts an unpinned key at the given position', () => {
    expect(upsertPinAt(P('a', 'b'), 'x', 0)).toEqual(P('x', 'a', 'b'));
    expect(upsertPinAt(P('a', 'b'), 'x', 1)).toEqual(P('a', 'x', 'b'));
    expect(upsertPinAt(P('a', 'b'), 'x', 2)).toEqual(P('a', 'b', 'x'));
  });

  it('pins into an empty list', () => {
    expect(upsertPinAt([], 'x', 0)).toEqual(P('x'));
  });

  it('moves an already-pinned key (index counted with the key removed)', () => {
    // dragging 'a' below 'b': others = [b, c], insertion index 1 → a b→ b a c
    expect(upsertPinAt(P('a', 'b', 'c'), 'a', 1)).toEqual(P('b', 'a', 'c'));
    expect(upsertPinAt(P('a', 'b', 'c'), 'c', 0)).toEqual(P('c', 'a', 'b'));
    expect(upsertPinAt(P('a', 'b', 'c'), 'a', 2)).toEqual(P('b', 'c', 'a'));
  });

  it('clamps out-of-range targets', () => {
    expect(upsertPinAt(P('a', 'b'), 'x', 99)).toEqual(P('a', 'b', 'x'));
    expect(upsertPinAt(P('a', 'b'), 'x', -1)).toEqual(P('x', 'a', 'b'));
  });

  it('returns the SAME array on a no-op drop (no settings write)', () => {
    const pins = P('a', 'b', 'c');
    expect(upsertPinAt(pins, 'a', 0)).toBe(pins);
    expect(upsertPinAt(pins, 'b', 1)).toBe(pins);
    expect(upsertPinAt(pins, 'c', 99)).toBe(pins);
  });

  it('duplicate entries of the key collapse into one at the target', () => {
    expect(upsertPinAt(P('a', 'x', 'b', 'x'), 'x', 0)).toEqual(P('x', 'a', 'b'));
  });
});

describe('prunePinned', () => {
  it('drops keys not in the valid set', () => {
    expect(prunePinned(P('a', 'dead', 'b'), new Set(['a', 'b']))).toEqual(P('a', 'b'));
  });
  it('returns null when nothing changed (no settings write)', () => {
    expect(prunePinned(P('a'), new Set(['a']))).toBeNull();
  });
});
