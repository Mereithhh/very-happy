/**
 * B-360, end to end through the store: two machine rows for ONE host must
 * render each terminal once.
 *
 * The pure rule lives in terminalPushOps (and is tested there); this test
 * covers the plumbing that rule depends on — that the snapshot's `updatedAt`
 * actually reaches `applyPush`. A refactor that drops it would leave every
 * pure test green while the duplicate came straight back.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import { pushedMachineSnapshots } from '@/sync/terminalPushOps';

let useTerminalSessions: typeof import('./terminalSessions').useTerminalSessions;

beforeAll(async () => {
  installBrowserTestGlobals();
  ({ useTerminalSessions } = await import('./terminalSessions'));
});

const NOW = 1_800_000_000_000;
/** The two tmux sessions the host actually has. Both machine rows see them. */
const shared = [
  { id: 'aaa', title: 'resource_moniter', createdAt: NOW - 60_000 },
  { id: 'bbb', title: 'en-other', createdAt: NOW - 30_000 },
];

/** A machine as the machines slice holds it: id + daemonState off the wire. */
function machine(id: string, updatedAt: number, terminals = shared) {
  return { id, daemonState: { startedAt: updatedAt - 1000, webTerminals: { updatedAt, terminals } } };
}

function feed(machines: ReturnType<typeof machine>[]) {
  for (const { id, snapshot } of pushedMachineSnapshots(machines)) {
    useTerminalSessions.getState().applyPush(id, 'ip-10-122-241-147', snapshot.terminals, snapshot.updatedAt);
  }
}

describe('B-360 two machine rows of one host, through the store', () => {
  beforeEach(() => {
    useTerminalSessions.setState({ terminals: [], pushes: {}, overlay: { created: [], renames: {}, removed: {} } });
  });

  it('renders each terminal once, owned by the live machine row', () => {
    // The retired row (handover left it behind) and the live one that replaced it.
    feed([machine('old-mid', NOW - 60_000), machine('new-mid', NOW)]);
    const rows = useTerminalSessions.getState().terminals;
    expect(rows.map((r) => r.id).sort()).toEqual(['aaa', 'bbb']);
    expect(rows.every((r) => r.machineId === 'new-mid')).toBe(true);
  });

  it('order of arrival does not matter — the live row wins either way', () => {
    feed([machine('new-mid', NOW), machine('old-mid', NOW - 60_000)]);
    expect(useTerminalSessions.getState().terminals).toHaveLength(2);
  });

  it('dropping the stale machine row leaves the same list', () => {
    feed([machine('old-mid', NOW - 60_000), machine('new-mid', NOW)]);
    useTerminalSessions.getState().clearPush('old-mid');
    const rows = useTerminalSessions.getState().terminals;
    expect(rows.map((r) => r.id).sort()).toEqual(['aaa', 'bbb']);
    expect(rows.every((r) => r.machineId === 'new-mid')).toBe(true);
  });

  it('two genuinely different machines keep both of their terminals', () => {
    feed([
      machine('m-a', NOW - 60_000, [{ id: 'aaa', title: 'A', createdAt: NOW }]),
      machine('m-b', NOW, [{ id: 'zzz', title: 'B', createdAt: NOW }]),
    ]);
    expect(useTerminalSessions.getState().terminals.map((r) => r.id).sort()).toEqual(['aaa', 'zzz']);
  });
});
