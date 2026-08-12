import { describe, it, expect } from 'vitest';
import {
  mergeBoardTasks,
  visibleTasks,
  orderKeyBetween,
  compareTaskOrder,
  planOrderWrites,
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

describe('orderKeyBetween (fractional lane keys)', () => {
  it('generates keys strictly inside the interval, at every boundary shape', () => {
    const mid = orderKeyBetween(null, null);
    expect(mid.length).toBeGreaterThan(0);
    const before = orderKeyBetween(null, mid);
    const after = orderKeyBetween(mid, null);
    expect(before < mid).toBe(true);
    expect(mid < after).toBe(true);
    const between = orderKeyBetween(before, mid);
    expect(before < between && between < mid).toBe(true);
  });

  it('never emits a key ending in the minimum digit (keeps room below)', () => {
    // repeatedly insert at the head — the pathological direction
    let head: string | null = null;
    for (let i = 0; i < 200; i++) {
      const k: string = orderKeyBetween(null, head);
      expect(k.endsWith('0')).toBe(false);
      if (head !== null) expect(k < head).toBe(true);
      head = k;
    }
  });

  it('repeated midpoint insertion stays ordered and grows sublinearly', () => {
    let a = orderKeyBetween(null, null);
    let b = orderKeyBetween(a, null);
    for (let i = 0; i < 100; i++) {
      const m: string = orderKeyBetween(a, b);
      expect(a < m && m < b).toBe(true);
      b = m; // keep splitting the same gap
    }
    expect(b.length).toBeLessThan(25); // ~log62 growth, not one char per insert
  });

  it('throws on an inverted or empty interval', () => {
    expect(() => orderKeyBetween('V', 'V')).toThrow();
    expect(() => orderKeyBetween('k', 'V')).toThrow();
  });
});

describe('compareTaskOrder', () => {
  it('keyed tasks sort lexicographically before unkeyed; unkeyed newest-first', () => {
    const list = [
      task({ id: 'legacyOld', createdAt: NOW - 50_000 }),
      task({ id: 'second', order: 'k' }),
      task({ id: 'legacyNew', createdAt: NOW - 10_000 }),
      task({ id: 'first', order: 'V' }),
    ];
    expect([...list].sort(compareTaskOrder).map((t) => t.id)).toEqual([
      'first',
      'second',
      'legacyNew',
      'legacyOld',
    ]);
  });

  it('equal keys (same-gap concurrent inserts) tiebreak by id — identical on every device', () => {
    const a = task({ id: 'a', order: 'V' });
    const b = task({ id: 'b', order: 'V' });
    expect([a, b].sort(compareTaskOrder).map((t) => t.id)).toEqual(
      [b, a].sort(compareTaskOrder).map((t) => t.id),
    );
  });
});

describe('planOrderWrites', () => {
  it('moving one task between keyed neighbors writes exactly that task', () => {
    const seq = [
      task({ id: 'a', order: 'G' }),
      task({ id: 'moved', order: 'z' }), // dragged here from the tail
      task({ id: 'b', order: 'V' }),
      task({ id: 'c', order: 'k' }),
    ];
    const writes = planOrderWrites(seq, 'moved');
    expect(writes).toHaveLength(1);
    expect(writes[0].id).toBe('moved');
    expect(writes[0].order > 'G' && writes[0].order < 'V').toBe(true);
  });

  it('materializes keys for a legacy (unkeyed) list in display order', () => {
    const seq = [task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' })];
    const writes = planOrderWrites(seq, 'b');
    expect(writes.map((w) => w.id)).toEqual(['a', 'b', 'c']);
    expect(writes[0].order < writes[1].order && writes[1].order < writes[2].order).toBe(true);
  });

  it('re-keys the whole sequence when kept keys are not strictly increasing', () => {
    const seq = [
      task({ id: 'a', order: 'k' }),
      task({ id: 'b', order: 'V' }), // corrupt: out of order
      task({ id: 'c', order: 'V' }),
    ];
    const writes = planOrderWrites(seq);
    const orders = new Map(writes.map((w) => [w.id, w.order]));
    const finalKeys = seq.map((t) => orders.get(t.id) ?? t.order!);
    for (let i = 1; i < finalKeys.length; i++) {
      expect(finalKeys[i - 1] < finalKeys[i]).toBe(true);
    }
  });

  it('is a no-op for an already-consistent sequence', () => {
    const seq = [task({ id: 'a', order: 'G' }), task({ id: 'b', order: 'V' })];
    expect(planOrderWrites(seq)).toEqual([]);
  });
});

describe('mergeBoardTasks × order (concurrent drag semantics)', () => {
  it('drags of DIFFERENT tasks on two devices both survive the merge', () => {
    const base = [
      task({ id: 'a', order: 'G', orderAt: NOW - 100_000 }),
      task({ id: 'b', order: 'V', orderAt: NOW - 100_000 }),
      task({ id: 'c', order: 'k', orderAt: NOW - 100_000 }),
    ];
    // device L drags a after c; device R drags b before a
    const local = base.map((t) => (t.id === 'a' ? { ...t, order: 's', orderAt: NOW - 5_000 } : t));
    const remote = base.map((t) => (t.id === 'b' ? { ...t, order: 'C', orderAt: NOW - 4_000 } : t));
    const merged = mergeBoardTasks(local, remote, NOW);
    const byId = new Map(merged.map((t) => [t.id, t]));
    expect(byId.get('a')!.order).toBe('s');
    expect(byId.get('b')!.order).toBe('C');
    expect([...merged].sort(compareTaskOrder).map((t) => t.id)).toEqual(['b', 'c', 'a']);
  });

  it('same task dragged on both devices → newer orderAt wins', () => {
    const local = [task({ id: 'a', order: 'B', orderAt: NOW - 10_000 })];
    const remote = [task({ id: 'a', order: 'x', orderAt: NOW - 1_000 })];
    expect(mergeBoardTasks(local, remote, NOW)[0].order).toBe('x');
    expect(mergeBoardTasks(remote, local, NOW)[0].order).toBe('x');
  });

  it('a drag (orderAt) and a rename (updatedAt) of the SAME task both survive', () => {
    // device L dragged the task; device R renamed it later
    const local = [task({ id: 'a', order: 's', orderAt: NOW - 5_000, updatedAt: NOW - 60_000 })];
    const remote = [task({ id: 'a', title: 'renamed', updatedAt: NOW - 1_000 })];
    const merged = mergeBoardTasks(local, remote, NOW);
    expect(merged[0].title).toBe('renamed'); // record winner: remote
    expect(merged[0].order).toBe('s'); // order winner: local drag
    expect(merged[0].orderAt).toBe(NOW - 5_000);
  });

  it('an unkeyed side never erases the other side\'s key on an orderAt tie', () => {
    const keyed = [task({ id: 'a', order: 'V', orderAt: NOW - 5_000, updatedAt: NOW - 1_000 })];
    const legacy = [task({ id: 'a', updatedAt: NOW - 1_000 })];
    // legacy has orderAt 0 → keyed side always newer; but also check the
    // both-zero tie with order on one side only
    expect(mergeBoardTasks(keyed, legacy, NOW)[0].order).toBe('V');
    expect(mergeBoardTasks(legacy, keyed, NOW)[0].order).toBe('V');
    const tieKeyed = [task({ id: 'a', order: 'V' })];
    const tiePlain = [task({ id: 'a' })];
    expect(mergeBoardTasks(tiePlain, tieKeyed, NOW)[0].order).toBe('V');
    expect(mergeBoardTasks(tieKeyed, tiePlain, NOW)[0].order).toBe('V');
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
