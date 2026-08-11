import { describe, expect, it } from 'vitest';
import {
  GRACE_MS,
  RECENT_MUTATION_MS,
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
