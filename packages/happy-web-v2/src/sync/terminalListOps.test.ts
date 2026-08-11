import { describe, expect, it } from 'vitest';
import {
  GRACE_MS,
  RECENT_MUTATION_MS,
  TOMBSTONE_TTL_MS,
  activeTerminals,
  mergeTerminalLists,
  reconcileWithMachine,
  type TerminalSession,
} from './terminalListOps';

const NOW = 1_700_000_000_000;
const OLD = NOW - RECENT_MUTATION_MS - 1_000; // safely past the backfill guard

function rec(partial: Partial<TerminalSession> & { id: string }): TerminalSession {
  return {
    machineId: 'm1',
    machineName: 'mac',
    title: 'mac',
    createdAt: OLD,
    updatedAt: OLD,
    ...partial,
  } as TerminalSession;
}

describe('reconcileWithMachine — title sync', () => {
  it('backfills the machine title into an existing record (A renamed → B sees it)', () => {
    const cur = [rec({ id: 't1', title: 'old name' })];
    const { next, changed, pushTitles } = reconcileWithMachine(
      cur, 'm1', 'mac', [{ id: 't1', title: 'new name' }], NOW,
    );
    expect(changed).toBe(true);
    expect(pushTitles).toEqual([]);
    expect(next[0].title).toBe('new name');
    expect(next[0].manual).toBe(true); // a set @vh_title must not be auto-titled over
    expect(next[0].updatedAt).toBe(NOW);
  });

  it('does NOT backfill over a record mutated within the stale-snapshot window', () => {
    const cur = [rec({ id: 't1', title: 'fresh rename', updatedAt: NOW - 2_000 })];
    const { changed } = reconcileWithMachine(
      cur, 'm1', 'mac', [{ id: 't1', title: 'stale title' }], NOW,
    );
    expect(changed).toBe(false);
  });

  it('pendingTitle: pushes the local title instead of backfilling the stale machine value', () => {
    const cur = [rec({ id: 't1', title: 'renamed offline', pendingTitle: true })];
    const { next, changed, pushTitles } = reconcileWithMachine(
      cur, 'm1', 'mac', [{ id: 't1', title: 'stale' }], NOW,
    );
    expect(changed).toBe(false);
    expect(next[0].title).toBe('renamed offline');
    expect(pushTitles).toEqual([{ id: 't1', machineId: 'm1', title: 'renamed offline' }]);
  });

  it('pendingTitle: clears once the machine reports the same title', () => {
    const cur = [rec({ id: 't1', title: 'done', pendingTitle: true })];
    const { next, changed, pushTitles } = reconcileWithMachine(
      cur, 'm1', 'mac', [{ id: 't1', title: 'done' }], NOW,
    );
    expect(changed).toBe(true);
    expect(pushTitles).toEqual([]);
    expect(next[0].pendingTitle).toBeUndefined();
  });

  it('heals a legacy manual rename the machine never received (empty @vh_title)', () => {
    const cur = [rec({ id: 't1', title: 'my server', manual: true })];
    const { changed, pushTitles } = reconcileWithMachine(
      cur, 'm1', 'mac', [{ id: 't1' }], NOW,
    );
    expect(changed).toBe(false);
    expect(pushTitles).toEqual([{ id: 't1', machineId: 'm1', title: 'my server' }]);
  });

  it('keeps the local title when the machine has none and the record is not manual', () => {
    const cur = [rec({ id: 't1', title: 'npm run dev' })];
    const { changed, pushTitles } = reconcileWithMachine(cur, 'm1', 'mac', [{ id: 't1' }], NOW);
    expect(changed).toBe(false);
    expect(pushTitles).toEqual([]);
  });
});

describe('reconcileWithMachine — membership (pre-existing semantics)', () => {
  it('adopts orphans present on the machine but missing locally', () => {
    const { next, changed } = reconcileWithMachine(
      [], 'm1', 'mac', [{ id: 't9', title: 'elsewhere', createdAt: OLD }], NOW,
    );
    expect(changed).toBe(true);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: 't9', title: 'elsewhere', manual: true, machineId: 'm1' });
  });

  it('reaps dead records but spares ones inside the spawn grace window', () => {
    const cur = [
      rec({ id: 'dead', createdAt: NOW - GRACE_MS - 1 }),
      rec({ id: 'spawning', createdAt: NOW - 1_000 }),
      rec({ id: 'other-machine', machineId: 'm2' }),
    ];
    const { next } = reconcileWithMachine(cur, 'm1', 'mac', [], NOW);
    expect(next.map((t) => t.id)).toEqual(['spawning', 'other-machine']);
  });

  it('is a no-op (changed=false, identical elements) in steady state', () => {
    const cur = [rec({ id: 't1', title: 'same' })];
    const { next, changed } = reconcileWithMachine(
      cur, 'm1', 'mac', [{ id: 't1', title: 'same' }], NOW,
    );
    expect(changed).toBe(false);
    expect(next[0]).toBe(cur[0]);
  });
});

describe('deletion tombstones', () => {
  it('keeps a tombstone while its tmux is still alive (kill sent, waiting) and does NOT re-adopt it', () => {
    const cur = [rec({ id: 't1', deletedAt: OLD, updatedAt: OLD })];
    const { next, changed, pushTitles } = reconcileWithMachine(
      cur, 'm1', 'mac', [{ id: 't1', title: 'still here' }], NOW,
    );
    expect(changed).toBe(false);
    expect(pushTitles).toEqual([]);
    expect(next).toHaveLength(1);
    expect(next[0]).toBe(cur[0]); // untouched: no backfill, no adoption copy
    expect(next[0].deletedAt).toBe(OLD);
  });

  it('keeps a tombstone whose tmux is gone while within the TTL (offline devices must merge against it)', () => {
    const cur = [rec({ id: 't1', deletedAt: NOW - TOMBSTONE_TTL_MS + 60_000 })];
    const { next, changed } = reconcileWithMachine(cur, 'm1', 'mac', [], NOW);
    expect(changed).toBe(false);
    expect(next).toHaveLength(1);
  });

  it('physically clears a tombstone once the tmux is gone AND the tombstone aged past the TTL', () => {
    const cur = [rec({ id: 't1', deletedAt: NOW - TOMBSTONE_TTL_MS - 1 })];
    const { next, changed } = reconcileWithMachine(cur, 'm1', 'mac', [], NOW);
    expect(changed).toBe(true);
    expect(next).toHaveLength(0);
  });

  it('does not clear an expired tombstone while the tmux still lives', () => {
    const cur = [rec({ id: 't1', deletedAt: NOW - TOMBSTONE_TTL_MS - 1 })];
    const { next } = reconcileWithMachine(cur, 'm1', 'mac', [{ id: 't1' }], NOW);
    expect(next).toHaveLength(1);
    expect(next[0].deletedAt).toBeDefined();
  });

  it('tombstones are exempt from title push even with pendingTitle/manual set', () => {
    const cur = [rec({ id: 't1', title: 'renamed', manual: true, pendingTitle: true, deletedAt: OLD })];
    const { pushTitles } = reconcileWithMachine(
      cur, 'm1', 'mac', [{ id: 't1', title: 'other' }], NOW,
    );
    expect(pushTitles).toEqual([]);
  });

  it('merge: the tombstone (newer mutation) beats a device still carrying the pre-delete record', () => {
    const alive = rec({ id: 'a', updatedAt: OLD });
    const dead = rec({ id: 'a', deletedAt: NOW, updatedAt: NOW });
    // deletion made locally, remote device still has the live record…
    expect(mergeTerminalLists([dead], [alive])[0].deletedAt).toBe(NOW);
    // …and the other way around (deletion arrived via KV).
    expect(mergeTerminalLists([alive], [dead])[0].deletedAt).toBe(NOW);
  });

  it('activeTerminals hides tombstoned records from renderers', () => {
    const list = [rec({ id: 'a' }), rec({ id: 'b', deletedAt: NOW })];
    expect(activeTerminals(list).map((t) => t.id)).toEqual(['a']);
  });
});

describe('mergeTerminalLists — per-terminal KV merge', () => {
  it('two devices editing DIFFERENT terminals no longer clobber each other', () => {
    const shared = { machineId: 'm1', machineName: 'mac', createdAt: OLD };
    const local = [
      rec({ ...shared, id: 'a', title: 'a renamed by us', updatedAt: NOW }),
      rec({ ...shared, id: 'b', title: 'b old', updatedAt: OLD }),
    ];
    const remote = [
      rec({ ...shared, id: 'a', title: 'a old', updatedAt: OLD }),
      rec({ ...shared, id: 'b', title: 'b renamed by them', updatedAt: NOW }),
    ];
    const merged = mergeTerminalLists(local, remote);
    expect(merged.find((t) => t.id === 'a')!.title).toBe('a renamed by us');
    expect(merged.find((t) => t.id === 'b')!.title).toBe('b renamed by them');
  });

  it('newer updatedAt wins per id; ties keep the local record', () => {
    const local = [rec({ id: 'a', title: 'local', updatedAt: NOW })];
    const remote = [rec({ id: 'a', title: 'remote', updatedAt: NOW })];
    expect(mergeTerminalLists(local, remote)[0].title).toBe('local');
  });

  it('unions ids: remote-only records are prepended (newest first)', () => {
    const local = [rec({ id: 'mine' })];
    const remote = [
      rec({ id: 'theirs-old', createdAt: OLD - 10 }),
      rec({ id: 'theirs-new', createdAt: OLD + 10 }),
    ];
    expect(mergeTerminalLists(local, remote).map((t) => t.id)).toEqual([
      'theirs-new', 'theirs-old', 'mine',
    ]);
  });

  it('falls back to createdAt when updatedAt is missing (pre-fix records)', () => {
    const local = [rec({ id: 'a', title: 'older', updatedAt: undefined, createdAt: OLD })];
    const remote = [rec({ id: 'a', title: 'newer', updatedAt: undefined, createdAt: OLD + 5 })];
    expect(mergeTerminalLists(local, remote)[0].title).toBe('newer');
  });
});
