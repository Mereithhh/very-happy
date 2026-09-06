/**
 * B-361, through the wiring: a superseded machine row must not reach the
 * terminal store, and it must stay reachable in exactly one place.
 *
 * The pure rule is tested in supersededMachines.test.ts. What this covers is
 * the part a pure test cannot: that terminalSync actually applies it, so a
 * leftover row's frozen `daemonState` stops contributing ghost terminals.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';

let useTerminalSessions: typeof import('./terminalSessions').useTerminalSessions;
let storage: typeof import('./storage').storage;
let syncTerminalsOnce: () => void;

const NOW = 1_800_000_000_000;
const HOME = '/home/ubuntu/.happy';

beforeAll(async () => {
  installBrowserTestGlobals();
  ({ useTerminalSessions } = await import('./terminalSessions'));
  ({ storage } = await import('./storage'));
  const sync = await import('./terminalSync');
  // The module's exported hook owns the subscription; the ingest step itself is
  // what we want, so drive it the way the hook's effect does.
  syncTerminalsOnce = sync.syncPushesForTest;
});

/** A machine row as the storage slice holds it. */
function machineRow(id: string, opts: { active: boolean; activeAt: number; terminalIds: string[]; host?: string }) {
  return {
    id,
    seq: 0,
    createdAt: NOW - 100_000,
    updatedAt: NOW,
    active: opts.active,
    activeAt: opts.activeAt,
    metadataVersion: 1,
    daemonStateVersion: 1,
    metadata: {
      host: opts.host ?? 'ip-10-122-241-147',
      platform: 'linux',
      happyHomeDir: HOME,
      happyCliVersion: '0.2.120',
      homeDir: '/home/ubuntu',
    },
    daemonState: {
      startedAt: opts.activeAt - 1_000,
      webTerminals: {
        updatedAt: opts.activeAt,
        terminals: opts.terminalIds.map((tid) => ({ id: tid, title: tid, createdAt: NOW - 10_000 })),
      },
    },
  } as any;
}

function seed(machines: any[]) {
  storage.setState({
    isDataReady: true,
    machines: Object.fromEntries(machines.map((m) => [m.id, m])),
  } as any);
  useTerminalSessions.setState({ terminals: [], pushes: {}, overlay: { created: [], renames: {}, removed: {} } });
}

describe('B-361 a superseded machine row never reaches the terminal store', () => {
  beforeEach(() => {
    seed([]);
  });

  it('drops the leftover row\'s frozen terminals, including ones the live daemon no longer has', () => {
    seed([
      // Abandoned at the handover: still remembers a terminal that is long gone.
      machineRow('t1-old', { active: false, activeAt: NOW - 60_000, terminalIds: ['aaa', 'ghost'] }),
      machineRow('t1-new', { active: true, activeAt: NOW, terminalIds: ['aaa'] }),
    ]);
    syncTerminalsOnce();
    const rows = useTerminalSessions.getState().terminals;
    expect(rows.map((r) => r.id)).toEqual(['aaa']);
    expect(rows[0].machineId).toBe('t1-new');
  });

  it('a genuinely offline SECOND machine keeps showing its terminals', () => {
    // The deliberate behaviour B-361 must not break: a sleeping laptop is not
    // a leftover, and its terminals still belong in the list.
    seed([
      machineRow('t2-laptop', { active: false, activeAt: NOW - 60_000, terminalIds: ['zzz'], host: 'mac-office' }),
      machineRow('t2-server', { active: true, activeAt: NOW, terminalIds: ['bbb'] }),
    ]);
    syncTerminalsOnce();
    expect(useTerminalSessions.getState().terminals.map((r) => r.id).sort()).toEqual(['bbb', 'zzz']);
  });

  it('retires terminals a row contributed before it became superseded', () => {
    // Order matters in life: the leftover is often ingested first (page load),
    // and only later does the replacement come online.
    seed([machineRow('t3-old', { active: true, activeAt: NOW - 60_000, terminalIds: ['ccc', 'ghost'] })]);
    syncTerminalsOnce();
    expect(useTerminalSessions.getState().terminals).toHaveLength(2);

    seed([
      machineRow('t3-old', { active: false, activeAt: NOW - 60_000, terminalIds: ['ccc', 'ghost'] }),
      machineRow('t3-new', { active: true, activeAt: NOW, terminalIds: ['ccc'] }),
    ]);
    syncTerminalsOnce();
    expect(useTerminalSessions.getState().terminals.map((r) => r.id)).toEqual(['ccc']);
  });
});

describe('B-361 useAllMachines is the funnel', () => {
  it('drops superseded rows by default, and only Settings opts back in', () => {
    // Every machine-enumerating surface (sidebar, pickers, board, banners)
    // goes through useAllMachines, so the filter belongs there rather than in
    // each caller. A refactor that drops it would leave the pure tests green.
    const src = readFileSync(new URL('./storage.ts', import.meta.url), 'utf8');
    expect(src).toContain('const machines = includeSuperseded ? all : withoutSupersededMachines(all);');
  });
});

describe('B-361 the leftover stays reachable in Settings', () => {
  it('the machine list asks for superseded rows and labels them', () => {
    // Hiding a row the user can neither see nor delete would be worse than the
    // duplicate it replaces — the delete action lives behind this list.
    const src = readFileSync(new URL('../screens/settings/MachinesSettings.tsx', import.meta.url), 'utf8');
    expect(src).toContain('includeSuperseded: true');
    expect(src).toContain("t('settingsMachines.superseded')");
  });
});
