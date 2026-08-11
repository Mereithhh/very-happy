import { describe, it, expect } from 'vitest';
import {
  buildBoardItems,
  formatCwd,
  ENDED_WINDOW_MS,
  type BoardInput,
} from './boardItems';
import type { Session, Machine } from '@/sync/storageTypes';
import type { TerminalSession } from '@/sync/terminalListOps';
import type { TerminalAgentEntry } from '@/sync/terminalAgentState';

const NOW = 1_700_000_000_000;

function mkSession(over: Partial<Session> & { id: string }): Session {
  return {
    seq: 0,
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 60_000,
    active: true,
    activeAt: NOW - 60_000,
    metadata: {
      path: '/home/u/proj',
      homeDir: '/home/u',
      host: 'devbox',
      machineId: 'm1',
      summary: { text: 'Fix the tests', updatedAt: NOW },
    } as Session['metadata'],
    metadataVersion: 0,
    agentState: null,
    agentStateVersion: 0,
    thinking: false,
    thinkingAt: 0,
    presence: 'online',
    ...over,
  } as Session;
}

function mkMachine(id: string, active: boolean, name = `mach-${id}`): Machine {
  return {
    id,
    seq: 0,
    createdAt: NOW - 86_400_000,
    updatedAt: NOW,
    active,
    activeAt: NOW,
    metadata: { host: name } as Machine['metadata'],
    metadataVersion: 0,
    daemonState: null,
    daemonStateVersion: 0,
  };
}

function mkTerminal(over: Partial<TerminalSession> & { id: string }): TerminalSession {
  return {
    machineId: 'm1',
    machineName: 'mach-m1',
    title: `term ${over.id}`,
    createdAt: NOW - 600_000,
    updatedAt: NOW - 600_000,
    ...over,
  };
}

function build(over: Partial<BoardInput>): ReturnType<typeof buildBoardItems> {
  return buildBoardItems({
    sessions: [],
    terminals: [],
    agentStates: {},
    machines: [mkMachine('m1', true)],
    now: NOW,
    ...over,
  });
}

describe('formatCwd', () => {
  it('shortens home-relative paths and handles edge shapes', () => {
    expect(formatCwd('/home/u/proj', '/home/u')).toBe('~/proj');
    expect(formatCwd('/home/u', '/home/u')).toBe('~');
    expect(formatCwd('/home/u/proj', '/home/u/')).toBe('~/proj');
    expect(formatCwd('/opt/x', '/home/u')).toBe('/opt/x');
    // prefix match must be segment-aligned, not substring
    expect(formatCwd('/home/uu/proj', '/home/u')).toBe('/home/uu/proj');
    expect(formatCwd(undefined)).toBe('');
  });
});

describe('chat session mapping', () => {
  it('online session with a pending permission request → attention, earliest request wins', () => {
    const s = mkSession({
      id: 's1',
      agentState: {
        requests: {
          r2: { tool: 'Bash', arguments: {}, createdAt: NOW - 30_000 },
          r1: { tool: 'Edit', arguments: {}, createdAt: NOW - 240_000 },
        },
      },
    });
    const [item] = build({ sessions: [s] });
    expect(item.status).toBe('attention');
    expect(item.attentionSince).toBe(NOW - 240_000);
    expect(item.detail).toEqual({ kind: 'tool', name: 'Edit' });
    expect(item.href).toBe('/session/s1');
    expect(item.cwd).toBe('~/proj');
  });

  it('active+thinking → working; active+online quiet → idle', () => {
    const working = mkSession({ id: 's1', thinking: true });
    const idle = mkSession({ id: 's2' });
    const items = build({ sessions: [working, idle] });
    expect(items.find((i) => i.key === 's1')!.status).toBe('working');
    expect(items.find((i) => i.key === 's2')!.status).toBe('idle');
  });

  it('inactive session within 24h → ended; older → dropped', () => {
    const recent = mkSession({ id: 's1', active: false, presence: NOW - 60_000, updatedAt: NOW - 60_000 });
    const old = mkSession({
      id: 's2',
      active: false,
      presence: NOW - ENDED_WINDOW_MS - 1,
      updatedAt: NOW - ENDED_WINDOW_MS - 1,
    });
    const items = build({ sessions: [recent, old] });
    expect(items.map((i) => i.key)).toEqual(['s1']);
    expect(items[0].status).toBe('ended');
  });

  it('pending requests do NOT make a disconnected session attention', () => {
    const s = mkSession({
      id: 's1',
      presence: NOW - 60_000,
      active: false,
      agentState: { requests: { r: { tool: 'Bash', arguments: {}, createdAt: NOW - 10_000 } } },
    });
    const [item] = build({ sessions: [s] });
    expect(item.status).toBe('ended');
  });
});

describe('terminal mapping', () => {
  const entry = (state: TerminalAgentEntry['state'], over: Partial<TerminalAgentEntry> = {}): TerminalAgentEntry => ({
    machineId: 'm1',
    state,
    ...over,
  });

  it('needs_input → attention (since from the entry); working → working', () => {
    const items = build({
      terminals: [mkTerminal({ id: 't1' }), mkTerminal({ id: 't2' })],
      agentStates: {
        t1: entry('needs_input', { since: NOW - 120_000, cwd: '/srv/app' }),
        t2: entry('working'),
      },
    });
    const t1 = items.find((i) => i.key === 't:t1')!;
    expect(t1.status).toBe('attention');
    expect(t1.attentionSince).toBe(NOW - 120_000);
    expect(t1.cwd).toBe('/srv/app');
    expect(t1.href).toBe('/terminal/m1?tid=t1');
    expect(items.find((i) => i.key === 't:t2')!.status).toBe('working');
  });

  it('deletion-tombstoned terminals never appear on the board', () => {
    const items = build({
      terminals: [mkTerminal({ id: 't1', deletedAt: NOW - 1000 })],
      agentStates: { t1: entry('needs_input') },
    });
    expect(items.find((i) => i.key === 't:t1')).toBeUndefined();
  });

  it('shell / idle / unknown (old daemon) → idle, never attention', () => {
    const items = build({
      terminals: [
        mkTerminal({ id: 't1' }),
        mkTerminal({ id: 't2' }),
        mkTerminal({ id: 't3' }), // no agentState entry at all
      ],
      agentStates: { t1: entry('shell'), t2: entry('idle') },
    });
    expect(items.map((i) => i.status)).toEqual(['idle', 'idle', 'idle']);
  });

  it('OFFLINE machine: stale needs_input is gated out of attention → ended + machineOffline', () => {
    const items = build({
      machines: [mkMachine('m1', false)],
      terminals: [mkTerminal({ id: 't1', updatedAt: NOW - 60_000 })],
      agentStates: { t1: entry('needs_input', { since: NOW - 120_000 }) },
    });
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('ended');
    expect(items[0].detail).toEqual({ kind: 'machineOffline' });
  });

  it('unknown machine id counts as offline', () => {
    const items = build({
      machines: [],
      terminals: [mkTerminal({ id: 't1', machineId: 'ghost', updatedAt: NOW - 1000 })],
      agentStates: { t1: { machineId: 'ghost', state: 'needs_input' } },
    });
    expect(items[0].status).toBe('ended');
  });

  it('offline-machine terminal older than 24h falls off the board', () => {
    const items = build({
      machines: [mkMachine('m1', false)],
      terminals: [mkTerminal({ id: 't1', createdAt: NOW - ENDED_WINDOW_MS - 1, updatedAt: NOW - ENDED_WINDOW_MS - 1 })],
    });
    expect(items).toHaveLength(0);
  });

  it('lastActivityAt prefers daemon activityAt over the record timestamps', () => {
    const items = build({
      terminals: [mkTerminal({ id: 't1', updatedAt: NOW - 600_000 })],
      agentStates: { t1: entry('working', { activityAt: NOW - 5_000 }) },
    });
    expect(items[0].lastActivityAt).toBe(NOW - 5_000);
  });
});

describe('ordering', () => {
  it('ranks attention→working→idle→ended; attention oldest-wait first, others recent first', () => {
    const items = build({
      sessions: [
        mkSession({ id: 'sIdle', updatedAt: NOW - 50_000 }),
        mkSession({ id: 'sEnded', active: false, presence: NOW - 1000, updatedAt: NOW - 1000 }),
        mkSession({
          id: 'sWaitShort',
          agentState: { requests: { r: { tool: 'Bash', arguments: {}, createdAt: NOW - 10_000 } } },
        }),
        mkSession({
          id: 'sWaitLong',
          agentState: { requests: { r: { tool: 'Edit', arguments: {}, createdAt: NOW - 300_000 } } },
        }),
        mkSession({ id: 'sWork1', thinking: true, updatedAt: NOW - 90_000 }),
      ],
      terminals: [mkTerminal({ id: 'tWork2' })],
      agentStates: { tWork2: { machineId: 'm1', state: 'working', activityAt: NOW - 10_000 } },
    });
    expect(items.map((i) => i.key)).toEqual([
      'sWaitLong', // waited longest → first
      'sWaitShort',
      't:tWork2', // working, most recent activity first
      'sWork1',
      'sIdle',
      'sEnded',
    ]);
  });

  it('key tiebreak keeps equal-timestamp items stable', () => {
    const a = mkSession({ id: 'b-second', updatedAt: NOW - 1000 });
    const b = mkSession({ id: 'a-first', updatedAt: NOW - 1000 });
    const items = build({ sessions: [a, b] });
    expect(items.map((i) => i.key)).toEqual(['a-first', 'b-second']);
  });
});
