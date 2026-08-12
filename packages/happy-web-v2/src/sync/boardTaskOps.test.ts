import { describe, it, expect } from 'vitest';
import {
  mergeBoardTasks,
  visibleTasks,
  TASK_TOMBSTONE_TTL_MS,
  type BoardTask,
} from './boardTaskOps';

const NOW = 1_700_000_000_000;

function task(over: Partial<BoardTask> & { id: string }): BoardTask {
  return {
    title: `Task ${over.id}`,
    status: 'open',
    createdAt: NOW - 100_000,
    updatedAt: NOW - 100_000,
    ...over,
  };
}

describe('mergeBoardTasks', () => {
  it('newer updatedAt wins per task id', () => {
    const local = [task({ id: 'a', title: 'old title', updatedAt: NOW - 50_000 })];
    const remote = [task({ id: 'a', title: 'renamed elsewhere', updatedAt: NOW - 1_000 })];
    const merged = mergeBoardTasks(local, remote, NOW);
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe('renamed elsewhere');
  });

  it('local newer beats remote older', () => {
    const local = [task({ id: 'a', title: 'fresh local edit', updatedAt: NOW - 1_000 })];
    const remote = [task({ id: 'a', title: 'stale', updatedAt: NOW - 50_000 })];
    expect(mergeBoardTasks(local, remote, NOW)[0].title).toBe('fresh local edit');
  });

  it('unions the id sets: remote-only tasks are appended newest-first', () => {
    const local = [task({ id: 'a' })];
    const remote = [
      task({ id: 'b', createdAt: NOW - 10_000 }),
      task({ id: 'c', createdAt: NOW - 5_000 }),
    ];
    const merged = mergeBoardTasks(local, remote, NOW);
    expect(merged.map((t) => t.id)).toEqual(['c', 'b', 'a']);
  });

  it('a deletion tombstone is the newest mutation and wins (no resurrection)', () => {
    const local = [task({ id: 'a', status: 'deleted', updatedAt: NOW - 1_000 })];
    const remote = [task({ id: 'a', status: 'open', updatedAt: NOW - 60_000 })]; // pre-delete copy
    const merged = mergeBoardTasks(local, remote, NOW);
    expect(merged[0].status).toBe('deleted');
  });

  it('sessionIds are UNIONED across both sides even when one record wins', () => {
    // Device A dispatched s2 (older write); device B renamed the task (newer).
    const local = [task({ id: 'a', sessionIds: ['s1', 's2'], updatedAt: NOW - 60_000 })];
    const remote = [task({ id: 'a', title: 'renamed', sessionIds: ['s1', 's3'], updatedAt: NOW - 1_000 })];
    const merged = mergeBoardTasks(local, remote, NOW);
    expect(merged[0].title).toBe('renamed');
    expect(merged[0].sessionIds).toEqual(['s1', 's2', 's3']);
  });

  it('expired tombstones are physically dropped; fresh ones are kept', () => {
    const local = [
      task({ id: 'old', status: 'deleted', updatedAt: NOW - TASK_TOMBSTONE_TTL_MS - 1 }),
      task({ id: 'fresh', status: 'deleted', updatedAt: NOW - 1_000 }),
    ];
    const merged = mergeBoardTasks(local, [], NOW);
    expect(merged.map((t) => t.id)).toEqual(['fresh']);
  });

  it('is idempotent: merging the merged result with either input changes nothing', () => {
    const local = [task({ id: 'a', updatedAt: NOW - 1_000 }), task({ id: 'b' })];
    const remote = [task({ id: 'a', updatedAt: NOW - 50_000, sessionIds: ['s9'] }), task({ id: 'c' })];
    const merged = mergeBoardTasks(local, remote, NOW);
    expect(mergeBoardTasks(merged, remote, NOW)).toEqual(merged);
  });
});

describe('visibleTasks', () => {
  it('hides tombstones, keeps open and done', () => {
    const list = [
      task({ id: 'a' }),
      task({ id: 'b', status: 'done' }),
      task({ id: 'c', status: 'deleted' }),
    ];
    expect(visibleTasks(list).map((t) => t.id)).toEqual(['a', 'b']);
  });
});
