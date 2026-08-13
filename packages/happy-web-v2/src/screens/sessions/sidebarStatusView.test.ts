import { describe, it, expect } from 'vitest';
import { groupRowsByLifecycle, completedTodaySessions } from './sidebarStatusView';
import type { Session } from '@/sync/storageTypes';

type R = { key: string; ts: number };
const row = (key: string, ts = 0): R => ({ key, ts });

describe('groupRowsByLifecycle', () => {
  it('splits rows by the board lifecycle verdict', () => {
    const groups = groupRowsByLifecycle(
      [row('a'), row('b'), row('c')],
      [
        { key: 'a', lifecycle: 'waiting' },
        { key: 'b', lifecycle: 'running' },
        { key: 'c', lifecycle: 'waiting' },
      ],
    );
    expect(groups.waiting.map((r) => r.key)).toEqual(['a', 'c']);
    expect(groups.running.map((r) => r.key)).toEqual(['b']);
  });

  it('orders each group by MOST RECENT ACTIVITY, not by board order', () => {
    // The board's own total order is "longest neglected first" — a different
    // question from the sidebar's "where was I", so it is deliberately not
    // reused inside the groups. Board input order is the reverse of activity
    // order here, so a regression to board order would fail loudly.
    const board = [
      { key: 'wait-stale', lifecycle: 'waiting' as const },
      { key: 'wait-fresh', lifecycle: 'waiting' as const },
      { key: 'run-stale', lifecycle: 'running' as const },
      { key: 'run-fresh', lifecycle: 'running' as const },
    ];
    const rows = [row('run-stale', 10), row('wait-fresh', 400), row('run-fresh', 300), row('wait-stale', 20)];
    const groups = groupRowsByLifecycle(rows, board);
    expect(groups.waiting.map((r) => r.key)).toEqual(['wait-fresh', 'wait-stale']);
    expect(groups.running.map((r) => r.key)).toEqual(['run-fresh', 'run-stale']);
  });

  it('merges off-board rows into waiting by the same activity key', () => {
    const groups = groupRowsByLifecycle(
      [row('gone-old', 100), row('on-board', 150), row('gone-new', 200), row('gone-tie', 100)],
      [{ key: 'on-board', lifecycle: 'waiting' }],
    );
    expect(groups.waiting.map((r) => r.key)).toEqual(['gone-new', 'on-board', 'gone-old', 'gone-tie']);
    expect(groups.running).toEqual([]);
  });

  it('never invents running membership for off-board rows', () => {
    const groups = groupRowsByLifecycle([row('x', 5)], []);
    expect(groups.running).toEqual([]);
    expect(groups.waiting.map((r) => r.key)).toEqual(['x']);
  });
});

describe('completedTodaySessions', () => {
  const NOW = 1_000_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;
  const sess = (id: string, completedAt?: number): Session =>
    ({
      id,
      active: false,
      createdAt: NOW - DAY,
      updatedAt: NOW - DAY,
      activeAt: NOW - DAY,
      metadata: completedAt ? { completedAt } : {},
    }) as unknown as Session;

  it('returns only sessions completed within the 24h window, newest first', () => {
    const list = [
      sess('old', NOW - DAY - 1), // outside the window
      sess('a', NOW - 3600_000),
      sess('never'), // no completedAt
      sess('b', NOW - 60_000),
    ];
    expect(completedTodaySessions(list, NOW).map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('is empty when nothing was completed', () => {
    expect(completedTodaySessions([sess('x')], NOW)).toEqual([]);
  });
});
