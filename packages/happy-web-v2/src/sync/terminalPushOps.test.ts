/**
 * Unit tests for the pushed-terminal-list model: the trust rule (feature
 * detection + downgrade fallback), the sync-lane partition, list composition
 * (pushed ∪ overlay ∪ legacy) and overlay pruning.
 */
import { describe, it, expect } from 'vitest';
import type { MachineTerminal } from '@/sync/ops';
import type { TerminalSession } from '@/sync/terminalListOps';
import {
  trustedWebTerminals,
  partitionMachinesForSync,
  composeTerminalList,
  pruneOverlay,
  EMPTY_OVERLAY,
  CREATE_OVERLAY_TTL_MS,
  RENAME_OVERLAY_TTL_MS,
  REMOVE_OVERLAY_TTL_MS,
  type PushOverlay,
} from './terminalPushOps';

const NOW = 1_800_000_000_000;

function term(over: Partial<MachineTerminal> = {}): MachineTerminal {
  return { id: 'aaa', title: 'Task A', cwd: '/x', createdAt: NOW - 60_000, activityAt: NOW - 1000, agentState: 'idle', ...over };
}

function kvRow(over: Partial<TerminalSession> = {}): TerminalSession {
  return { id: 'kv1', machineId: 'legacy-m', machineName: 'old-box', title: 'Legacy', createdAt: NOW - 90_000, updatedAt: NOW - 90_000, ...over };
}

describe('trustedWebTerminals', () => {
  const state = (over: any = {}) => ({
    status: 'running',
    startedAt: NOW - 10_000,
    webTerminals: { updatedAt: NOW - 5000, terminals: [term()] },
    ...over,
  });

  it('accepts a snapshot written by the current daemon run (updatedAt >= startedAt)', () => {
    const snap = trustedWebTerminals(state());
    expect(snap).not.toBeNull();
    expect(snap!.updatedAt).toBe(NOW - 5000);
    expect(snap!.terminals).toHaveLength(1);
  });

  it('accepts updatedAt EXACTLY equal to startedAt (the connect write stamps both with one clock reading)', () => {
    expect(trustedWebTerminals(state({ startedAt: NOW, webTerminals: { updatedAt: NOW, terminals: [] } }))).not.toBeNull();
  });

  it('rejects a stale snapshot after a daemon downgrade (startedAt advanced past updatedAt)', () => {
    expect(trustedWebTerminals(state({ startedAt: NOW - 1000, webTerminals: { updatedAt: NOW - 5000, terminals: [term()] } }))).toBeNull();
  });

  it('trusts an offline machine\'s persisted snapshot (updatedAt from the last run >= that run\'s startedAt)', () => {
    // Clean shutdown spreads state: startedAt stays from the run that wrote it.
    expect(trustedWebTerminals(state({ status: 'shutting-down' }))).not.toBeNull();
  });

  it('rejects old daemons (no field) and malformed shapes', () => {
    expect(trustedWebTerminals(null)).toBeNull();
    expect(trustedWebTerminals({ status: 'running' })).toBeNull();
    expect(trustedWebTerminals(state({ webTerminals: { terminals: [term()] } }))).toBeNull(); // no updatedAt
    expect(trustedWebTerminals(state({ webTerminals: { updatedAt: NOW, terminals: 'nope' } }))).toBeNull();
  });

  it('tolerates a missing startedAt (treated as 0)', () => {
    expect(trustedWebTerminals(state({ startedAt: undefined }))).not.toBeNull();
  });

  it('drops malformed items but keeps the snapshot', () => {
    const snap = trustedWebTerminals(state({
      webTerminals: { updatedAt: NOW, terminals: [term(), null, { title: 'no id' }, { id: '' }] },
    }));
    expect(snap!.terminals).toHaveLength(1);
  });
});

describe('partitionMachinesForSync', () => {
  const pushCapable = { id: 'new-m', active: true, daemonState: { startedAt: NOW - 10, webTerminals: { updatedAt: NOW, terminals: [] } } };
  const oldOnline = { id: 'old-m', active: true, daemonState: { startedAt: NOW - 10 } };
  const oldOffline = { id: 'off-m', active: false, daemonState: { startedAt: NOW - 10 } };
  const offlinePushed = { id: 'offp-m', active: false, daemonState: { startedAt: NOW - 100, webTerminals: { updatedAt: NOW - 50, terminals: [term()] } } };

  it('pushed machines are never polled; online legacy machines are; offline legacy machines are neither', () => {
    const { pushed, pollIds } = partitionMachinesForSync([pushCapable, oldOnline, oldOffline, offlinePushed]);
    expect(pushed.map((p) => p.id).sort()).toEqual(['new-m', 'offp-m']);
    expect(pollIds).toEqual(['old-m']);
  });

  it('a downgraded daemon (stale snapshot) falls back to the poll lane', () => {
    const downgraded = { id: 'down-m', active: true, daemonState: { startedAt: NOW, webTerminals: { updatedAt: NOW - 50, terminals: [] } } };
    const { pushed, pollIds } = partitionMachinesForSync([downgraded]);
    expect(pushed).toEqual([]);
    expect(pollIds).toEqual(['down-m']);
  });
});

describe('composeTerminalList', () => {
  const pushes = {
    'push-m': { machineName: 'new-box', terminals: [term({ id: 'aaa' }), term({ id: 'bbb', title: '', createdAt: NOW - 30_000 })] },
  };

  it('renders pushed rows (newest first) with legacy rows for other machines after them', () => {
    const kv = [kvRow()];
    const rows = composeTerminalList(kv, pushes, EMPTY_OVERLAY, NOW);
    expect(rows.map((r) => r.id)).toEqual(['bbb', 'aaa', 'kv1']);
    const bbb = rows[0];
    expect(bbb.machineId).toBe('push-m');
    expect(bbb.machineName).toBe('new-box');
    expect(bbb.title).toBe('new-box'); // no daemon title → machine-name fallback
    expect(bbb.manual).toBe(false);
    const aaa = rows[1];
    expect(aaa.title).toBe('Task A');
    expect(aaa.manual).toBe(true);
  });

  it('drops KV records that belong to a pushed machine (old-web leftovers must not duplicate)', () => {
    const kv = [kvRow({ id: 'aaa', machineId: 'push-m' }), kvRow()];
    const rows = composeTerminalList(kv, pushes, EMPTY_OVERLAY, NOW);
    expect(rows.filter((r) => r.id === 'aaa')).toHaveLength(1);
    expect(rows.map((r) => r.id)).toContain('kv1');
  });

  it('keeps legacy tombstones in the list untouched (consumers hide them via activeTerminals)', () => {
    const kv = [kvRow({ deletedAt: NOW - 1000 })];
    const rows = composeTerminalList(kv, pushes, EMPTY_OVERLAY, NOW);
    expect(rows.find((r) => r.id === 'kv1')?.deletedAt).toBe(NOW - 1000);
  });

  it('applies an unexpired rename overlay and marks the row manual', () => {
    const overlay: PushOverlay = { ...EMPTY_OVERLAY, renames: { aaa: { title: 'My Name', at: NOW - 1000 } } };
    const rows = composeTerminalList([], pushes, overlay, NOW);
    expect(rows.find((r) => r.id === 'aaa')!.title).toBe('My Name');
    expect(rows.find((r) => r.id === 'aaa')!.manual).toBe(true);
  });

  it('an expired rename overlay stops overriding (honest revert)', () => {
    const overlay: PushOverlay = { ...EMPTY_OVERLAY, renames: { aaa: { title: 'My Name', at: NOW - RENAME_OVERLAY_TTL_MS - 1 } } };
    const rows = composeTerminalList([], pushes, overlay, NOW);
    expect(rows.find((r) => r.id === 'aaa')!.title).toBe('Task A');
  });

  it('hides a removed terminal until the TTL, then honestly shows it again', () => {
    const hidden: PushOverlay = { ...EMPTY_OVERLAY, removed: { aaa: NOW - 1000 } };
    expect(composeTerminalList([], pushes, hidden, NOW).map((r) => r.id)).toEqual(['bbb']);
    const expired: PushOverlay = { ...EMPTY_OVERLAY, removed: { aaa: NOW - REMOVE_OVERLAY_TTL_MS - 1 } };
    expect(composeTerminalList([], pushes, expired, NOW).map((r) => r.id)).toEqual(['bbb', 'aaa']);
  });

  it('shows optimistic creations first, but not once the push carries the id (no duplicates)', () => {
    const created = kvRow({ id: 'new1', machineId: 'push-m', machineName: 'new-box', createdAt: NOW - 1000 });
    const overlay: PushOverlay = { ...EMPTY_OVERLAY, created: [created] };
    expect(composeTerminalList([], pushes, overlay, NOW).map((r) => r.id)).toEqual(['new1', 'bbb', 'aaa']);
    const confirmed = {
      'push-m': { machineName: 'new-box', terminals: [...pushes['push-m'].terminals, term({ id: 'new1', createdAt: NOW - 1000 })] },
    };
    expect(composeTerminalList([], confirmed, overlay, NOW).filter((r) => r.id === 'new1')).toHaveLength(1);
  });

  it('expires optimistic creations after the TTL (open never happened)', () => {
    const created = kvRow({ id: 'new1', machineId: 'push-m', createdAt: NOW - CREATE_OVERLAY_TTL_MS - 1 });
    const overlay: PushOverlay = { ...EMPTY_OVERLAY, created: [created] };
    expect(composeTerminalList([], pushes, overlay, NOW).map((r) => r.id)).toEqual(['bbb', 'aaa']);
  });

  it('an empty pushed list still suppresses the machine\'s KV records (push says: no terminals)', () => {
    const kv = [kvRow({ id: 'stale', machineId: 'push-m' })];
    const rows = composeTerminalList(kv, { 'push-m': { machineName: 'new-box', terminals: [] } }, EMPTY_OVERLAY, NOW);
    expect(rows).toEqual([]);
  });
});

describe('pruneOverlay', () => {
  const pushes = { 'push-m': { machineName: 'new-box', terminals: [term({ id: 'aaa', title: 'Task A' })] } };

  it('returns the SAME object when nothing changed', () => {
    const overlay: PushOverlay = { ...EMPTY_OVERLAY, renames: { aaa: { title: 'Other', at: NOW - 1000 } } };
    expect(pruneOverlay(overlay, pushes, NOW)).toBe(overlay);
  });

  it('clears a rename once the push carries the title back', () => {
    const overlay: PushOverlay = { ...EMPTY_OVERLAY, renames: { aaa: { title: 'Task A', at: NOW - 1000 } } };
    expect(pruneOverlay(overlay, pushes, NOW).renames).toEqual({});
  });

  it('clears a rename for a terminal that vanished, and an expired rename', () => {
    const overlay: PushOverlay = {
      ...EMPTY_OVERLAY,
      renames: {
        gone: { title: 'X', at: NOW - 1000 },
        aaa: { title: 'Y', at: NOW - RENAME_OVERLAY_TTL_MS - 1 },
      },
    };
    expect(pruneOverlay(overlay, pushes, NOW).renames).toEqual({});
  });

  it('clears a removal once the id is absent from every push (kill confirmed)', () => {
    const overlay: PushOverlay = { ...EMPTY_OVERLAY, removed: { gone: NOW - 1000, aaa: NOW - 1000 } };
    const pruned = pruneOverlay(overlay, pushes, NOW);
    expect(pruned.removed).toEqual({ aaa: NOW - 1000 }); // still pushed → still hiding
  });

  it('clears an expired removal (kill never landed)', () => {
    const overlay: PushOverlay = { ...EMPTY_OVERLAY, removed: { aaa: NOW - REMOVE_OVERLAY_TTL_MS - 1 } };
    expect(pruneOverlay(overlay, pushes, NOW).removed).toEqual({});
  });

  it('clears a creation once the push carries the id, keeps it while pending', () => {
    const pending = kvRow({ id: 'new1', machineId: 'push-m', createdAt: NOW - 1000 });
    const confirmed = kvRow({ id: 'aaa', machineId: 'push-m', createdAt: NOW - 1000 });
    const overlay: PushOverlay = { ...EMPTY_OVERLAY, created: [pending, confirmed] };
    expect(pruneOverlay(overlay, pushes, NOW).created).toEqual([pending]);
  });

  it('clears a creation whose machine fell back to the legacy path', () => {
    const pending = kvRow({ id: 'new1', machineId: 'other-m', createdAt: NOW - 1000 });
    const overlay: PushOverlay = { ...EMPTY_OVERLAY, created: [pending] };
    expect(pruneOverlay(overlay, pushes, NOW).created).toEqual([]);
  });
});
