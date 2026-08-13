import { describe, it, expect } from 'vitest';
import {
  resolveSidebarSort,
  sortRowsByRecent,
  shouldHoldReorder,
  applyReorderHold,
  REORDER_HOLD_MS,
} from './sidebarRecentSort';

const row = (key: string, ts: number) => ({ key, ts });

describe('resolveSidebarSort', () => {
  it("only the explicit 'manual' opt-in is manual", () => {
    expect(resolveSidebarSort('manual')).toBe('manual');
  });

  it("everything else — including undefined — reads as 'recent'", () => {
    // undefined is the case that matters: the field carries NO zod .default()
    // (ghost-pending footgun), so an old client / stripped blob lands here.
    expect(resolveSidebarSort(undefined)).toBe('recent');
    expect(resolveSidebarSort(null)).toBe('recent');
    expect(resolveSidebarSort('recent')).toBe('recent');
    expect(resolveSidebarSort('lifecycle-v2')).toBe('recent'); // future enum value
    expect(resolveSidebarSort(0)).toBe('recent');
  });
});

describe('sortRowsByRecent', () => {
  it('puts the most recently active row on top', () => {
    const out = sortRowsByRecent([row('a', 100), row('b', 300), row('c', 200)]);
    expect(out.map((r) => r.key)).toEqual(['b', 'c', 'a']);
  });

  it('mixes terminals and chats — no kind is pinned above the other', () => {
    const out = sortRowsByRecent([
      row('t:term-old', 100),
      row('sess-new', 300),
      row('t:term-new', 400),
      row('sess-old', 50),
    ]);
    expect(out.map((r) => r.key)).toEqual(['t:term-new', 'sess-new', 't:term-old', 'sess-old']);
  });

  it('breaks ties on the row key so the order is total (device-stable)', () => {
    const out = sortRowsByRecent([row('b', 1), row('a', 1), row('c', 1)]);
    expect(out.map((r) => r.key)).toEqual(['a', 'b', 'c']);
  });

  it('never mutates the input', () => {
    const input = [row('a', 1), row('b', 2)];
    sortRowsByRecent(input);
    expect(input.map((r) => r.key)).toEqual(['a', 'b']);
  });

  it('handles the empty list', () => {
    expect(sortRowsByRecent([])).toEqual([]);
  });
});

describe('shouldHoldReorder', () => {
  const NOW = 1_000_000;

  it('holds while the pointer is inside and recently moved', () => {
    expect(
      shouldHoldReorder({ pointerInside: true, lastPointerAt: NOW - 10, now: NOW }),
    ).toBe(true);
  });

  it('releases the instant the pointer leaves the list', () => {
    expect(
      shouldHoldReorder({ pointerInside: false, lastPointerAt: NOW - 10, now: NOW }),
    ).toBe(false);
  });

  it('releases after the hold window even with the pointer still inside', () => {
    // a cursor parked over the sidebar must not freeze it forever
    expect(
      shouldHoldReorder({ pointerInside: true, lastPointerAt: NOW - REORDER_HOLD_MS, now: NOW }),
    ).toBe(false);
    expect(
      shouldHoldReorder({ pointerInside: true, lastPointerAt: NOW - REORDER_HOLD_MS + 1, now: NOW }),
    ).toBe(true);
  });

  it('outlives a realistic read-then-click pause', () => {
    // Regression guard for the mis-click this hold exists to prevent. With the
    // realtime activity overlay a background terminal can reorder the list
    // about once a SECOND, so a hold that expires while the user is still
    // reading the row they are about to click is no protection at all: the row
    // slides away and the click lands on a different session. 3s is a normal
    // pause between "stop moving the mouse" and "click".
    expect(
      shouldHoldReorder({ pointerInside: true, lastPointerAt: NOW - 3000, now: NOW }),
    ).toBe(true);
  });

  it('honours an explicit holdMs', () => {
    expect(
      shouldHoldReorder({ pointerInside: true, lastPointerAt: NOW - 50, now: NOW, holdMs: 40 }),
    ).toBe(false);
  });

  it('never holds before the pointer has ever moved inside', () => {
    expect(shouldHoldReorder({ pointerInside: true, lastPointerAt: null, now: NOW })).toBe(false);
  });
});

describe('applyReorderHold', () => {
  it('renders the held sequence, not the fresh one', () => {
    const next = [row('c', 3), row('a', 2), row('b', 1)]; // freshly re-sorted
    expect(applyReorderHold(['a', 'b', 'c'], next).map((r) => r.key)).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op without a hold', () => {
    const next = [row('a', 1), row('b', 2)];
    expect(applyReorderHold(null, next)).toBe(next);
    expect(applyReorderHold([], next)).toBe(next);
  });

  it('returns the SAME array when the hold changes nothing', () => {
    const next = [row('a', 1), row('b', 2)];
    expect(applyReorderHold(['a', 'b'], next)).toBe(next);
  });

  it('drops rows that disappeared (archived / killed) — holding a dead row would lie', () => {
    const next = [row('a', 1), row('c', 3)];
    expect(applyReorderHold(['a', 'b', 'c'], next).map((r) => r.key)).toEqual(['a', 'c']);
  });

  it('appends rows that appeared at the BOTTOM, never above the pointer', () => {
    const next = [row('new', 9), row('a', 1), row('b', 2)];
    expect(applyReorderHold(['a', 'b'], next).map((r) => r.key)).toEqual(['a', 'b', 'new']);
  });

  it('tolerates a held sequence that is a superset of the rows (status groups)', () => {
    // the status view holds ONE flat sequence and applies it per lifecycle group
    const flat = ['w1', 'r1', 'w2', 'r2'];
    expect(applyReorderHold(flat, [row('r2', 5), row('r1', 9)]).map((r) => r.key)).toEqual([
      'r1',
      'r2',
    ]);
    expect(applyReorderHold(flat, [row('w2', 5), row('w1', 9)]).map((r) => r.key)).toEqual([
      'w1',
      'w2',
    ]);
  });

  it('survives a corrupt held sequence with duplicate keys', () => {
    const next = [row('b', 1), row('a', 2)];
    expect(applyReorderHold(['a', 'b', 'a'], next).map((r) => r.key)).toEqual(['a', 'b']);
  });

  it('handles an empty row list', () => {
    const next: Array<{ key: string; ts: number }> = [];
    expect(applyReorderHold(['a'], next)).toBe(next);
  });
});
