import { describe, it, expect } from 'vitest';
import {
  mergeActivity,
  pruneActivity,
  resolveActivityTs,
  parseActivityMap,
  activityKeyForTerminal,
  activityKeyForSession,
  EMPTY_ACTIVITY,
} from './activityOverlay';
import { sortRowsByRecent, applyReorderHold } from '@/screens/sessions/sidebarRecentSort';

const CAP = 10;

describe('activity keys', () => {
  it('matches the sidebar row-key convention', () => {
    // Sidebar builds terminal rows as `t:${tm.id}` and session rows as s.id —
    // ONE key space, or the overlay would silently miss every row.
    expect(activityKeyForTerminal('abc123')).toBe('t:abc123');
    expect(activityKeyForSession('sess-1')).toBe('sess-1');
  });
});

describe('mergeActivity', () => {
  it('takes the newer value per key', () => {
    const out = mergeActivity({ a: 100, b: 500 }, { a: 200, b: 400 }, CAP);
    expect(out).toEqual({ a: 200, b: 500 });
  });

  it('returns the SAME object when nothing moved (no re-render)', () => {
    const base = { a: 100 };
    expect(mergeActivity(base, { a: 100 }, CAP)).toBe(base);
    expect(mergeActivity(base, { a: 99 }, CAP)).toBe(base);
    expect(mergeActivity(base, {}, CAP)).toBe(base);
  });

  it('never moves a value backwards — a late frame cannot un-float a row', () => {
    const out = mergeActivity({ a: 5000 }, { a: 1000 }, CAP);
    expect(out).toEqual({ a: 5000 });
  });

  it('adds unknown keys', () => {
    expect(mergeActivity({}, { fresh: 42 }, CAP)).toEqual({ fresh: 42 });
  });

  it('ignores junk stamps', () => {
    const base = { a: 100 };
    expect(mergeActivity(base, { b: 0 }, CAP)).toBe(base);
    expect(mergeActivity(base, { b: -1 }, CAP)).toBe(base);
    expect(mergeActivity(base, { b: NaN }, CAP)).toBe(base);
    expect(mergeActivity(base, { b: Infinity }, CAP)).toBe(base);
    expect(mergeActivity(base, { b: 'x' as unknown as number }, CAP)).toBe(base);
  });

  it('does not mutate the input map', () => {
    const base = { a: 100 };
    mergeActivity(base, { a: 900, b: 1 }, CAP);
    expect(base).toEqual({ a: 100 });
  });

  it('caps the result, keeping the newest entries', () => {
    const base: Record<string, number> = {};
    for (let i = 0; i < 5; i++) base[`k${i}`] = 1000 + i;
    const out = mergeActivity(base, { k9: 9999 }, 3);
    expect(Object.keys(out).sort()).toEqual(['k3', 'k4', 'k9']);
  });
});

describe('pruneActivity', () => {
  it('is identity within the cap', () => {
    const m = { a: 1, b: 2 };
    expect(pruneActivity(m, 5)).toBe(m);
    expect(pruneActivity(m, 2)).toBe(m);
  });

  it('keeps the newest and breaks ties deterministically', () => {
    const out = pruneActivity({ z: 100, a: 100, m: 50 }, 2);
    // same stamp → key order, so two devices prune identically
    expect(Object.keys(out).sort()).toEqual(['a', 'z']);
  });
});

describe('resolveActivityTs', () => {
  it('floats a row with the newest of the three sources', () => {
    expect(resolveActivityTs(100, 'k', { k: 500 }, { k: 300 })).toBe(500);
    expect(resolveActivityTs(100, 'k', { k: 300 }, { k: 500 })).toBe(500);
  });

  it('falls back to the durable value when both overlays are empty', () => {
    // = today's behaviour: old daemon, old server, fresh profile, socket down.
    expect(resolveActivityTs(777, 'k', EMPTY_ACTIVITY, EMPTY_ACTIVITY)).toBe(777);
  });

  it('never sinks a row below its durable value', () => {
    // A stale local stamp from before a reload must not outrank fresh truth.
    expect(resolveActivityTs(9000, 'k', { k: 1 }, { k: 2 })).toBe(9000);
  });

  it('ignores other rows keys', () => {
    expect(resolveActivityTs(10, 'k', { other: 1e12 }, {})).toBe(10);
  });
});

describe('parseActivityMap', () => {
  const now = 1_000_000;
  const day = 24 * 60 * 60 * 1000;

  it('reads a well-formed map', () => {
    expect(parseActivityMap({ a: now - 10 }, now, day, CAP)).toEqual({ a: now - 10 });
  });

  it('drops entries older than the retention window', () => {
    expect(parseActivityMap({ old: now - day - 1, ok: now - 5 }, now, day, CAP)).toEqual({ ok: now - 5 });
  });

  it('degrades to no overlay for any garbage', () => {
    for (const junk of [null, undefined, 42, 'x', [], [1, 2]]) {
      expect(parseActivityMap(junk, now, day, CAP)).toEqual({});
    }
  });

  it('skips malformed entries but keeps the good ones', () => {
    const out = parseActivityMap({ a: 'x', b: null, c: now, '': now }, now, day, CAP);
    expect(out).toEqual({ c: now });
  });

  it('caps a bloated stored map', () => {
    const raw: Record<string, number> = {};
    for (let i = 0; i < 20; i++) raw[`k${i}`] = now - i;
    expect(Object.keys(parseActivityMap(raw, now, day, 3))).toHaveLength(3);
  });
});

// ── integration with the sorter + the hover freeze ──────────────────────────
// The overlay is applied while BUILDING rows, so it must flow through exactly
// the same sort and the same mis-click guard as the durable values do.

interface R { key: string; ts: number }

function rowsWithOverlay(
  base: R[],
  local: Record<string, number>,
  remote: Record<string, number>,
): R[] {
  return base.map((r) => ({ ...r, ts: resolveActivityTs(r.ts, r.key, local, remote) }));
}

describe('overlay + sortRowsByRecent', () => {
  const base: R[] = [
    { key: 't:one', ts: 1000 },
    { key: 't:two', ts: 2000 },
    { key: 'chat', ts: 3000 },
  ];

  it('a local interaction stamp floats its row to the top', () => {
    const rows = rowsWithOverlay(base, { 't:one': 9000 }, {});
    expect(sortRowsByRecent(rows).map((r) => r.key)).toEqual(['t:one', 'chat', 't:two']);
  });

  it('a remote output frame floats its row to the top', () => {
    const rows = rowsWithOverlay(base, {}, { 't:two': 9000 });
    expect(sortRowsByRecent(rows).map((r) => r.key)).toEqual(['t:two', 'chat', 't:one']);
  });

  it('order is unchanged when no overlay applies', () => {
    const rows = rowsWithOverlay(base, {}, {});
    expect(sortRowsByRecent(rows).map((r) => r.key)).toEqual(['chat', 't:two', 't:one']);
  });
});

describe('overlay + applyReorderHold (mis-click guard covers the new lane)', () => {
  const base: R[] = [
    { key: 'a', ts: 3000 },
    { key: 'b', ts: 2000 },
    { key: 'c', ts: 1000 },
  ];

  it('an overlay-driven reorder is FROZEN while the pointer is in the list', () => {
    const held = ['a', 'b', 'c']; // what was on screen when the pointer entered
    // 'c' just started printing — realtime says it belongs on top...
    const next = sortRowsByRecent(rowsWithOverlay(base, {}, { c: 9999 }));
    expect(next.map((r) => r.key)).toEqual(['c', 'a', 'b']);
    // ...but nothing may move under the pointer.
    expect(applyReorderHold(held, next).map((r) => r.key)).toEqual(['a', 'b', 'c']);
  });

  it('the same reorder applies the moment the hold releases', () => {
    const next = sortRowsByRecent(rowsWithOverlay(base, {}, { c: 9999 }));
    expect(applyReorderHold(null, next).map((r) => r.key)).toEqual(['c', 'a', 'b']);
  });

  it('a local stamp is held too — no lane bypasses the guard', () => {
    const held = ['a', 'b', 'c'];
    const next = sortRowsByRecent(rowsWithOverlay(base, { c: 9999 }, {}));
    expect(applyReorderHold(held, next).map((r) => r.key)).toEqual(['a', 'b', 'c']);
  });
});
