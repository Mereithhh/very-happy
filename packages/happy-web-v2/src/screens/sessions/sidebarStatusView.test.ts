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

  it('orders each group by BOARD order regardless of the row input order', () => {
    // board order: attention (longest wait first) → working → idle/ended
    const board = [
      { key: 'urgent-old', lifecycle: 'waiting' as const },
      { key: 'urgent-new', lifecycle: 'waiting' as const },
      { key: 'run-recent', lifecycle: 'running' as const },
      { key: 'run-older', lifecycle: 'running' as const },
      { key: 'reap', lifecycle: 'waiting' as const },
    ];
    const rows = [row('reap'), row('run-older'), row('urgent-new'), row('run-recent'), row('urgent-old')];
    const groups = groupRowsByLifecycle(rows, board);
    expect(groups.waiting.map((r) => r.key)).toEqual(['urgent-old', 'urgent-new', 'reap']);
    expect(groups.running.map((r) => r.key)).toEqual(['run-recent', 'run-older']);
  });

  it('tails off-board rows onto waiting, most recent first, key tiebreak', () => {
    const groups = groupRowsByLifecycle(
      [row('gone-old', 100), row('on-board', 0), row('gone-new', 200), row('gone-tie', 100)],
      [{ key: 'on-board', lifecycle: 'waiting' }],
    );
    expect(groups.waiting.map((r) => r.key)).toEqual(['on-board', 'gone-new', 'gone-old', 'gone-tie']);
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
